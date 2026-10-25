import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.getenv("DATABASE_PATH", str(BASE_DIR / "levelup.db"))
# Set DATABASE_URL (e.g. a free Neon / Supabase Postgres URL) in production.
# Without it the app falls back to a local SQLite file, which is WIPED on
# Render's free plan every time the service restarts or redeploys.
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
USE_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
SESSION_TTL_SECONDS = 60 * 60 * 24 * 90
PASSWORD_ITERATIONS = 310_000
AUTH_CACHE_SECONDS = 30

app = FastAPI(title="LevelUp API", version="2.1.0")
default_origins = (
    "http://localhost:5500,http://127.0.0.1:5500,"
    "https://level-up-virid-three.vercel.app"
)
origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", default_origins).split(",")
    if origin.strip()
]
app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

if USE_PG:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    pool = ConnectionPool(
        DATABASE_URL,
        min_size=1,
        max_size=5,
        max_idle=240,
        max_lifetime=1800,
        timeout=30,
        check=ConnectionPool.check_connection,
        kwargs={"row_factory": dict_row, "prepare_threshold": None},
        open=False,
    )
    pool.open(wait=True, timeout=30)
    INTEGRITY_ERRORS: tuple = (psycopg.errors.UniqueViolation,)
else:
    INTEGRITY_ERRORS = (sqlite3.IntegrityError,)


class Conn:
    """Thin wrapper so the same SQL (with ? placeholders) runs on both databases."""

    def __init__(self, con: Any) -> None:
        self.con = con

    def execute(self, sql: str, params: tuple = ()) -> Any:
        if USE_PG:
            sql = sql.replace("?", "%s")
        return self.con.execute(sql, params)


@contextmanager
def db():
    if USE_PG:
        with pool.connection() as con:  # commits on success, rolls back on error
            yield Conn(con)
    else:
        con = sqlite3.connect(DB_PATH, timeout=15)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        try:
            yield Conn(con)
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


def init_db() -> None:
    id_col = "SERIAL PRIMARY KEY" if USE_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
    email_col = "TEXT NOT NULL UNIQUE" + ("" if USE_PG else " COLLATE NOCASE")
    with db() as con:
        if not USE_PG:
            Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
            con.execute("PRAGMA journal_mode=WAL")
        con.execute(
            f"""CREATE TABLE IF NOT EXISTS users (
                id {id_col},
                email {email_col},
                display_name TEXT NOT NULL DEFAULT '',
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )
        con.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at DOUBLE PRECISION NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )
        con.execute(
            """CREATE TABLE IF NOT EXISTS plans (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                days_json TEXT NOT NULL,
                start_date TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        if not USE_PG:  # upgrade very old local SQLite files
            columns = {row["name"] for row in con.execute("PRAGMA table_info(users)")}
            if "display_name" not in columns:
                con.execute("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
            plan_columns = {row["name"] for row in con.execute("PRAGMA table_info(plans)")}
            if "start_date" not in plan_columns:
                con.execute("ALTER TABLE plans ADD COLUMN start_date TEXT NOT NULL DEFAULT ''")
        con.execute("CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)")
        con.execute("CREATE INDEX IF NOT EXISTS plans_user_idx ON plans(user_id)")
        con.execute("DELETE FROM sessions WHERE expires_at<?", (time.time(),))


init_db()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    return f"{PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        iterations, salt_hex, expected = encoded.split("$", 2)
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)
        )
        return secrets.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def create_session(user_id: int) -> dict[str, Any]:
    token = secrets.token_urlsafe(32)
    expires_at = time.time() + SESSION_TTL_SECONDS
    with db() as con:
        con.execute(
            "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), user_id, expires_at, now_iso()),
        )
        user = con.execute(
            "SELECT id,email,display_name FROM users WHERE id=?", (user_id,)
        ).fetchone()
    user_data = dict(user)
    user_data["name"] = user_data.pop("display_name") or user_data["email"].split("@", 1)[0]
    return {"token": token, "user": user_data, "expires_in": SESSION_TTL_SECONDS}


# Small in-memory cache so every API call does not need a database round trip.
_auth_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def authenticated_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Please sign in")
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now = time.time()
    cached = _auth_cache.get(token_hash)
    if cached and cached[0] > now:
        return dict(cached[1])
    with db() as con:
        row = con.execute(
            """SELECT users.id,users.email,users.display_name,sessions.expires_at
               FROM sessions JOIN users ON users.id=sessions.user_id
               WHERE sessions.token_hash=? AND sessions.expires_at>?""",
            (token_hash, now),
        ).fetchone()
        if row and row["expires_at"] - now < SESSION_TTL_SECONDS - 86400:
            # sliding expiry: active users never get logged out
            con.execute(
                "UPDATE sessions SET expires_at=? WHERE token_hash=?",
                (now + SESSION_TTL_SECONDS, token_hash),
            )
    if not row:
        _auth_cache.pop(token_hash, None)
        raise HTTPException(status_code=401, detail="Session expired; please sign in again")
    user = {
        "id": row["id"],
        "email": row["email"],
        "name": row["display_name"] or row["email"].split("@", 1)[0],
    }
    if len(_auth_cache) > 1000:
        _auth_cache.clear()
    _auth_cache[token_hash] = (now + AUTH_CACHE_SECONDS, user)
    return dict(user)


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)
    display_name: str = Field(default="", max_length=80)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        email = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ValueError("Enter a valid email address")
        return email

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str) -> str:
        return value.strip()


class ChecklistItem(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=300)
    is_completed: bool = False


class PlanTopic(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=300)
    checklist: list[ChecklistItem] = Field(default_factory=list, max_length=50)


class PlanDay(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=120)
    topics: list[PlanTopic] = Field(default_factory=list, max_length=50)


class PlanIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    start_date: date
    days: list[PlanDay] = Field(min_length=1, max_length=365)

    @model_validator(mode="after")
    def limit_total_checklist_items(self) -> "PlanIn":
        total = sum(len(topic.checklist) for day in self.days for topic in day.topics)
        if total > 10000:
            raise ValueError("A plan cannot contain more than 10,000 checklist items")
        identifiers = [day.id for day in self.days]
        identifiers.extend(topic.id for day in self.days for topic in day.topics)
        identifiers.extend(
            item.id
            for day in self.days
            for topic in day.topics
            for item in topic.checklist
        )
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Plan day, topic, and checklist IDs must be unique")
        return self


def serialized_plan(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "start_date": row["start_date"],
        "days": json.loads(row["days_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.api_route("/api/health", methods=["GET", "HEAD"])
def health() -> dict[str, str]:
    return {"status": "ok", "app": "LevelUp"}


@app.post("/api/auth/register")
def register(body: Credentials) -> dict[str, Any]:
    if not body.display_name:
        raise HTTPException(status_code=422, detail="Enter your name")
    try:
        with db() as con:
            cur = con.execute(
                "INSERT INTO users(email,display_name,password_hash,created_at) VALUES(?,?,?,?) RETURNING id",
                (body.email, body.display_name, password_hash(body.password), now_iso()),
            )
            user_id = cur.fetchone()["id"]
    except INTEGRITY_ERRORS as exc:
        raise HTTPException(status_code=409, detail="An account with this email already exists") from exc
    return create_session(user_id)


@app.post("/api/auth/login")
def login(body: Credentials) -> dict[str, Any]:
    with db() as con:
        user = con.execute(
            "SELECT id,password_hash FROM users WHERE email=?", (body.email,)
        ).fetchone()
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Email or password is incorrect")
    return create_session(user["id"])


@app.get("/api/auth/me")
def current_account(user: dict[str, Any] = Depends(authenticated_user)) -> dict[str, Any]:
    return user


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() == "bearer" and token:
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        _auth_cache.pop(token_hash, None)
        with db() as con:
            con.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
    return {"logged_out": True}


@app.get("/api/plans")
def list_plans(user: dict[str, Any] = Depends(authenticated_user)) -> list[dict[str, Any]]:
    with db() as con:
        rows = con.execute(
            "SELECT id,name,start_date,days_json,created_at,updated_at FROM plans WHERE user_id=? ORDER BY created_at DESC",
            (user["id"],),
        ).fetchall()
    return [serialized_plan(row) for row in rows]


@app.post("/api/plans")
def create_plan(
    body: PlanIn, user: dict[str, Any] = Depends(authenticated_user)
) -> dict[str, Any]:
    plan_id = str(uuid4())
    now = now_iso()
    with db() as con:
        con.execute(
            "INSERT INTO plans(id,user_id,name,start_date,days_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (
                plan_id,
                user["id"],
                body.name,
                body.start_date.isoformat(),
                json.dumps([day.model_dump(mode="json") for day in body.days], separators=(",", ":")),
                now,
                now,
            ),
        )
        row = con.execute(
            "SELECT id,name,start_date,days_json,created_at,updated_at FROM plans WHERE id=? AND user_id=?",
            (plan_id, user["id"]),
        ).fetchone()
    return serialized_plan(row)


@app.put("/api/plans/{plan_id}")
def update_plan(
    plan_id: str, body: PlanIn, user: dict[str, Any] = Depends(authenticated_user)
) -> dict[str, Any]:
    now = now_iso()
    with db() as con:
        cur = con.execute(
            "UPDATE plans SET name=?,start_date=?,days_json=?,updated_at=? WHERE id=? AND user_id=?",
            (
                body.name,
                body.start_date.isoformat(),
                json.dumps([day.model_dump(mode="json") for day in body.days], separators=(",", ":")),
                now,
                plan_id,
                user["id"],
            ),
        )
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Plan not found")
        row = con.execute(
            "SELECT id,name,start_date,days_json,created_at,updated_at FROM plans WHERE id=? AND user_id=?",
            (plan_id, user["id"]),
        ).fetchone()
    return serialized_plan(row)


class CheckIn(BaseModel):
    day_id: str = Field(min_length=1, max_length=64)
    topic_id: str = Field(min_length=1, max_length=64)
    item_id: str = Field(min_length=1, max_length=64)
    is_completed: bool


_plan_lock = threading.Lock()


@app.patch("/api/plans/{plan_id}/check")
def set_checked(
    plan_id: str, body: CheckIn, user: dict[str, Any] = Depends(authenticated_user)
) -> dict[str, str]:
    """Tick/untick ONE checklist item without re-uploading the whole plan."""
    with _plan_lock, db() as con:
        row = con.execute(
            "SELECT days_json FROM plans WHERE id=? AND user_id=?", (plan_id, user["id"])
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Plan not found")
        days = json.loads(row["days_json"])
        found = False
        for day in days:
            if day.get("id") != body.day_id:
                continue
            for topic in day.get("topics", []):
                if topic.get("id") != body.topic_id:
                    continue
                for item in topic.get("checklist", []):
                    if item.get("id") == body.item_id:
                        item["is_completed"] = body.is_completed
                        found = True
        if not found:
            raise HTTPException(status_code=404, detail="Checklist item not found")
        now = now_iso()
        con.execute(
            "UPDATE plans SET days_json=?,updated_at=? WHERE id=? AND user_id=?",
            (json.dumps(days, separators=(",", ":")), now, plan_id, user["id"]),
        )
    return {"updated_at": now}


@app.delete("/api/plans/{plan_id}")
def delete_plan(
    plan_id: str, user: dict[str, Any] = Depends(authenticated_user)
) -> dict[str, bool]:
    with db() as con:
        cur = con.execute(
            "DELETE FROM plans WHERE id=? AND user_id=?", (plan_id, user["id"])
        )
    if not cur.rowcount:
        raise HTTPException(status_code=404, detail="Plan not found")
    return {"deleted": True}