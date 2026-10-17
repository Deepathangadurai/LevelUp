# LevelUp

LevelUp is a learning-plan tracker where each account can create and manage multiple plans. Plans are not pre-filled: users choose the number of days, topics in each day, and checklist items in each topic, then enter their own names.

## Features

- Account registration with a display name, email/password sign-in, and sign-out.
- Private plan records scoped to the signed-in account.
- Multiple plans per account, each with 1-365 days.
- Up to 50 topics per day and up to 50 checklist items per topic.
- Checklist progress saved to the backend as it changes.
- Responsive, installable frontend.
- FastAPI backend with SQLite storage.

Accounts currently do not have email verification or password reset. Use a unique password and deploy the API over HTTPS. API sessions expire after 30 days.

## Run locally

Requirements: Python 3.10+ and a modern browser.

### 1. Start the API

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 2. Configure and serve the frontend

When opened on localhost, `frontend/config.js` automatically connects to `http://127.0.0.1:8000`. Configure the backend process `CORS_ORIGINS` environment variable to include the frontend origin (`http://localhost:5500` and `http://127.0.0.1:5500`); see `backend/.env.example` for the values.

```bash
cd frontend
python -m http.server 5500
```

Open `http://localhost:5500`, create an account, and start a plan. The API is required; there is no shared or device-only account fallback.

The app shell can load from cache when offline, but signing in and reading or saving plans require a connection to the configured API. Install it from the browser's install prompt/menu; the in-app **Install app** button appears in browsers that expose an install prompt.

## Deploy

### Frontend to Vercel

1. Import the repository into Vercel and set **Root Directory** to `frontend`.
2. Set `API_BASE_URL` in `frontend/config.js` to the deployed API origin. The empty non-local default does not connect to an API.
3. Deploy the frontend over HTTPS.

### API to Render

1. Create a Render Web Service from the repository with root directory `backend`.
2. Build command: `pip install -r requirements.txt`.
3. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`.
4. Attach a persistent disk at `/var/data` and set `DATABASE_PATH=/var/data/levelup.db`.
5. Set `CORS_ORIGINS` to the exact HTTPS frontend origin.
6. Deploy and check `/api/health`.

## API

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/plans`
- `POST /api/plans`
- `PUT /api/plans/{plan_id}`
- `DELETE /api/plans/{plan_id}`

All auth and plan endpoints require a bearer token returned by registration or login. Plan reads, updates, and deletes are restricted to the account that owns the plan.

## Existing data

The previous built-in 30-day roadmap and its global progress records are no longer used by the new plan interface. They are not automatically assigned to an account because the old data did not record who owned it.
