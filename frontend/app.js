const API_BASE = (window.LEVELUP_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
const TOKEN_KEY = 'levelup-session';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let token = localStorage.getItem(TOKEN_KEY) || '';
let user = null;
let plans = [];
let selectedPlanId = null;
let draft = null;
let editingPlanId = null;
let authMode = 'login';
let expandedDays = new Set();
let planWriteQueue = Promise.resolve();

function makeId() {
  return crypto.randomUUID();
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function errorMessage(error) {
  if (Array.isArray(error)) return error.map(item => item.msg).join(', ');
  return String(error || 'Request failed');
}

async function request(path, options = {}) {
  if (!API_BASE) throw new Error('The backend API URL is not configured.');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(API_BASE + path, { ...options, headers });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = errorMessage(data?.detail || data?.message || response.statusText);
    if (response.status === 401 && token) {
      token = '';
      user = null;
      localStorage.removeItem(TOKEN_KEY);
      showAuth(message);
    }
    throw new Error(message);
  }
  return data;
}

function showAuth(message = '') {
  $('#auth-screen').hidden = false;
  $('#app-shell').hidden = true;
  const registering = authMode === 'register';
  $('#auth-name-field').hidden = !registering;
  $('#auth-name').required = registering;
  if (!registering) $('#auth-name').value = '';
  $('#auth-title').textContent = authMode === 'login' ? 'Welcome back' : 'Create your account';
  $('#auth-description').textContent = authMode === 'login'
    ? 'Sign in to open your plans.'
    : 'Create an account to save your plans privately.';
  $('#auth-password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $('#auth-submit').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
  $('#auth-mode-toggle').textContent = authMode === 'login'
    ? 'Create an account'
    : 'Already have an account? Sign in';
  $('#auth-error').textContent = message;
  $('#api-config-hint').hidden = Boolean(API_BASE);
  $('#auth-submit').disabled = !API_BASE;
}

function showApp() {
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#account-name').textContent = user?.name || 'Learner';
  $('#account-name').title = user?.email || '';
  renderDashboard();
  showPage('home');
}

function showPage(page) {
  $$('.page').forEach(section => section.classList.toggle('active', section.id === `page-${page}`));
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  const titles = { home: 'Your plans', plans: 'Plan details', editor: 'Plan builder' };
  $('#page-title').textContent = titles[page] || 'LevelUp';
  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openSidebar() {
  const sidebar = $('#app-sidebar');
  sidebar.classList.add('open');
  sidebar.removeAttribute('inert');
  sidebar.setAttribute('aria-hidden', 'false');
  $('#sidebar-backdrop').hidden = false;
  $('#menu-btn').setAttribute('aria-expanded', 'true');
  $('#menu-btn').setAttribute('aria-label', 'Close navigation');
  $('#sidebar-close-btn').focus();
}

function closeSidebar() {
  const sidebar = $('#app-sidebar');
  if (!sidebar) return;
  const wasOpen = sidebar.classList.contains('open');
  sidebar.classList.remove('open');
  sidebar.setAttribute('inert', '');
  sidebar.setAttribute('aria-hidden', 'true');
  $('#sidebar-backdrop').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
  $('#menu-btn').setAttribute('aria-label', 'Open navigation');
  if (wasOpen) $('#menu-btn').focus();
}

function newDay(index) {
  return {
    id: makeId(),
    title: `Day ${index + 1}`,
    topics: [{ id: makeId(), title: '', checklist: [{ id: makeId(), title: '', is_completed: false }] }]
  };
}

function planStats(plan) {
  let total = 0;
  let done = 0;
  plan.days.forEach(day => day.topics.forEach(topic => topic.checklist.forEach(item => {
    total += 1;
    if (item.is_completed) done += 1;
  })));
  return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
}

function counterControl(label, singular, value, min, max, attributes) {
  const extraAttributes = Object.entries(attributes)
    .map(([key, attributeValue]) => `${key}="${escapeHTML(attributeValue)}"`)
    .join(' ');
  return `<label>${label}<span class="stepper">
    <button type="button" data-step="-1" aria-label="Remove one ${singular}" ${value <= min ? 'disabled' : ''}>−</button>
    <input type="number" min="${min}" max="${max}" value="${value}" aria-label="${label}" ${extraAttributes}>
    <button type="button" data-step="1" aria-label="Add one ${singular}" ${value >= max ? 'disabled' : ''}>+</button>
  </span></label>`;
}

function renderDashboard() {
  const grid = $('#plan-grid');
  const totalDays = plans.reduce((sum, plan) => sum + plan.days.length, 0);
  const stats = plans.reduce((summary, plan) => {
    const planProgress = planStats(plan);
    summary.done += planProgress.done;
    summary.items += planProgress.total;
    return summary;
  }, { done: 0, items: 0 });
  const greeting = user?.name ? `Welcome back, ${user.name}` : 'Welcome to LevelUp';
  $('#dashboard-greeting').textContent = greeting;
  $('#dashboard-summary').textContent = plans.length
    ? 'Pick up where you left off and keep making steady progress.'
    : 'Create a plan for something you want to learn or achieve.';
  $('#plan-count-label').textContent = `${plans.length} ${plans.length === 1 ? 'plan' : 'plans'}`;
  $('#dashboard-stats').innerHTML = `
    <article class="dashboard-stat"><span class="stat-icon">▦</span><span class="stat-label">YOUR PLANS</span><strong>${plans.length}</strong><small>Personal goals in progress</small></article>
    <article class="dashboard-stat"><span class="stat-icon purple">◷</span><span class="stat-label">PLANNED DAYS</span><strong>${totalDays}</strong><small>Across all your plans</small></article>
    <article class="dashboard-stat"><span class="stat-icon orange">✓</span><span class="stat-label">CHECKLIST PROGRESS</span><strong>${stats.done}<small class="of-total"> / ${stats.items}</small></strong><small>Items completed</small></article>`;
  if (!plans.length) {
    grid.innerHTML = `<div class="empty-state dashboard-empty"><span class="empty-icon">✳</span><strong>Your next goal starts here</strong><span>Create a plan, choose its structure, and track progress one checklist at a time.</span><button class="primary-btn" data-create-plan>Create your first plan <span>+</span></button></div>`;
    return;
  }
  grid.innerHTML = plans.map(plan => {
    const stats = planStats(plan);
    const topicCount = plan.days.reduce((sum, day) => sum + day.topics.length, 0);
    return `<article class="plan-card">
      <div class="plan-card-top"><span class="category-symbol">▦</span><span class="plan-percent">${stats.percent}%</span></div>
      <h3>${escapeHTML(plan.name)}</h3>
      <p>${plan.days.length} days · ${topicCount} topics · ${stats.done}/${stats.total} checklist items</p>
      <div class="progress-track"><div class="progress-fill" style="width:${stats.percent}%"></div></div>
      <button class="secondary-btn" data-open-plan="${escapeHTML(plan.id)}">Open plan</button>
    </article>`;
  }).join('');
}

function renderPlanDetail() {
  const plan = plans.find(item => item.id === selectedPlanId);
  if (!plan) {
    $('#plan-detail').innerHTML = '<div class="empty-state"><strong>Choose a plan</strong>Open a plan from your dashboard.</div>';
    return;
  }
  const stats = planStats(plan);
  $('#plan-detail').innerHTML = `
    <div class="plan-detail-head">
      <div class="plan-detail-toolbar">
        <button class="back-to-plans" data-go-home aria-label="Back to all plans">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m7 7-7-7 7-7"></path></svg>
        </button>
      <div class="plan-tools">
        <button class="secondary-btn" data-edit-plan="${escapeHTML(plan.id)}">Edit plan</button>
        <button class="danger-btn" data-delete-plan="${escapeHTML(plan.id)}">Delete plan</button>
      </div>
      </div>
      <span class="eyebrow">${plan.days.length} DAYS · ${stats.done}/${stats.total} CHECKLIST ITEMS COMPLETE</span>
      <h2>${escapeHTML(plan.name)}</h2>
      <div class="progress-track"><div class="progress-fill" style="width:${stats.percent}%"></div></div>
      <p class="muted">${stats.percent}% complete</p>
    </div>
    <div class="user-day-list">${plan.days.map((day, index) => {
      const checklist = day.topics.flatMap(topic => topic.checklist);
      const complete = checklist.filter(item => item.is_completed).length;
      const isOpen = expandedDays.has(day.id);
      return `<article class="user-day-card ${isOpen ? 'open' : ''}">
        <button class="user-day-toggle" data-toggle-day="${escapeHTML(day.id)}" aria-expanded="${isOpen}">
          <span class="day-number">${String(index + 1).padStart(2, '0')}</span>
          <span class="day-title-wrap"><strong>${escapeHTML(day.title)}</strong><small>${day.topics.length} topics</small></span>
          <span class="day-progress"><small>${complete}/${checklist.length} done</small></span>
          <span class="chevron">›</span>
        </button>
        <div class="user-day-content">${day.topics.length ? day.topics.map(topic => `
          <section class="user-topic">
            <h3>${escapeHTML(topic.title)}</h3>
            ${topic.checklist.length ? topic.checklist.map(item => `
              <label class="topic-row ${item.is_completed ? 'done' : ''}">
                <input type="checkbox" data-checklist-id="${escapeHTML(item.id)}" data-day-id="${escapeHTML(day.id)}" data-topic-id="${escapeHTML(topic.id)}" ${item.is_completed ? 'checked' : ''}>
                <span class="topic-title">${escapeHTML(item.title)}</span>
              </label>`).join('') : '<p class="muted">No checklist items for this topic.</p>'}
          </section>`).join('') : '<p class="muted">No topics added for this day.</p>'}
        </div>
      </article>`;
    }).join('')}</div>`;
}

function renderBuilder() {
  if (!draft) return;
  $('#builder-name').value = draft.name;
  $('#builder-day-count').value = draft.days.length;
  $('#builder-days').innerHTML = draft.days.map((day, dayIndex) => `
    <article class="builder-day">
      <div class="builder-day-head"><span class="day-number">${String(dayIndex + 1).padStart(2, '0')}</span>
        <label>Day name<input maxlength="120" required data-day-title="${escapeHTML(day.id)}" value="${escapeHTML(day.title)}"></label>
        ${counterControl('Topics in this day', 'topic', day.topics.length, 0, 50, { 'data-topic-count': day.id })}
      </div>
      <div class="builder-topic-list">${day.topics.map((topic, topicIndex) => `
        <section class="builder-topic">
          <div class="builder-topic-head"><h3>Topic ${topicIndex + 1}</h3>
            ${counterControl('Checklist items', 'checklist item', topic.checklist.length, 0, 50, { 'data-checklist-count': day.id, 'data-count-topic-id': topic.id })}
          </div>
          <label>Topic name<input maxlength="300" required data-topic-title="${escapeHTML(topic.id)}" value="${escapeHTML(topic.title)}" placeholder="Name this topic"></label>
          <div class="builder-checklist">${topic.checklist.map((item, itemIndex) => `
            <label>Checklist item ${itemIndex + 1}<input maxlength="300" required data-checklist-title="${escapeHTML(item.id)}" value="${escapeHTML(item.title)}" placeholder="Name this checklist item"></label>
          `).join('')}</div>
        </section>
      `).join('')}</div>
    </article>
  `).join('');
}

function beginPlanEditor(plan = null) {
  editingPlanId = plan?.id || null;
  draft = plan
    ? JSON.parse(JSON.stringify(plan))
    : { name: '', days: Array.from({ length: 7 }, (_, index) => newDay(index)) };
  $('#editor-heading').textContent = plan ? 'Edit plan' : 'Create a plan';
  $('#editor-error').textContent = '';
  renderBuilder();
  showPage('editor');
  $('#builder-name').focus();
}

function resizeDays(count) {
  const target = Number(count);
  if (!Number.isInteger(target) || target < 1 || target > 365) {
    $('#editor-error').textContent = 'Choose between 1 and 365 days.';
    return;
  }
  $('#editor-error').textContent = '';
  while (draft.days.length < target) draft.days.push(newDay(draft.days.length));
  draft.days.length = target;
  renderBuilder();
}

function updateTopicCount(dayId, count) {
  const day = draft.days.find(item => item.id === dayId);
  const target = Number(count);
  if (!day) return;
  if (!Number.isInteger(target) || target < 0 || target > 50) {
    $('#editor-error').textContent = 'Choose between 0 and 50 topics per day.';
    renderBuilder();
    return;
  }
  $('#editor-error').textContent = '';
  while (day.topics.length < target) {
    day.topics.push({ id: makeId(), title: '', checklist: [] });
  }
  day.topics.length = target;
  renderBuilder();
}

function updateChecklistCount(dayId, topicId, count) {
  const day = draft.days.find(item => item.id === dayId);
  const topic = day?.topics.find(item => item.id === topicId);
  const target = Number(count);
  if (!topic) return;
  if (!Number.isInteger(target) || target < 0 || target > 50) {
    $('#editor-error').textContent = 'Choose between 0 and 50 checklist items per topic.';
    renderBuilder();
    return;
  }
  $('#editor-error').textContent = '';
  while (topic.checklist.length < target) {
    topic.checklist.push({ id: makeId(), title: '', is_completed: false });
  }
  topic.checklist.length = target;
  renderBuilder();
}

function validateDraft() {
  draft.name = $('#builder-name').value.trim();
  if (!draft.name) return 'Enter a name for this plan.';
  for (let dayIndex = 0; dayIndex < draft.days.length; dayIndex += 1) {
    const day = draft.days[dayIndex];
    day.title = day.title.trim() || `Day ${dayIndex + 1}`;
    for (let topicIndex = 0; topicIndex < day.topics.length; topicIndex += 1) {
      const topic = day.topics[topicIndex];
      if (!topic.title.trim()) return `Enter a name for Topic ${topicIndex + 1} on ${day.title}.`;
      for (let itemIndex = 0; itemIndex < topic.checklist.length; itemIndex += 1) {
        if (!topic.checklist[itemIndex].title.trim()) {
          return `Enter a name for checklist item ${itemIndex + 1} in ${topic.title}.`;
        }
      }
    }
  }
  return '';
}

async function savePlan(event) {
  event.preventDefault();
  const validationError = validateDraft();
  if (validationError) {
    $('#editor-error').textContent = validationError;
    return;
  }
  const button = $('#save-plan-btn');
  button.disabled = true;
  $('#editor-error').textContent = '';
  try {
    const path = editingPlanId ? `/api/plans/${encodeURIComponent(editingPlanId)}` : '/api/plans';
    const plan = await request(path, {
      method: editingPlanId ? 'PUT' : 'POST',
      body: JSON.stringify({ name: draft.name, days: draft.days })
    });
    const index = plans.findIndex(item => item.id === plan.id);
    if (index === -1) plans.unshift(plan);
    else plans[index] = plan;
    selectedPlanId = plan.id;
    expandedDays = new Set();
    renderDashboard();
    renderPlanDetail();
    showPage('plans');
    toast(editingPlanId ? 'Plan updated' : 'Plan created');
  } catch (error) {
    $('#editor-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function toggleChecklist(target) {
  const plan = plans.find(item => item.id === selectedPlanId);
  const day = plan?.days.find(item => item.id === target.dataset.dayId);
  const topic = day?.topics.find(item => item.id === target.dataset.topicId);
  const item = topic?.checklist.find(value => value.id === target.dataset.checklistId);
  if (!plan || !item) return;
  const previousValue = item.is_completed;
  item.is_completed = target.checked;
  const openDays = new Set(expandedDays);
  renderPlanDetail();
  try {
    const body = JSON.stringify({ name: plan.name, days: plan.days });
    const write = planWriteQueue.then(() => request(
      `/api/plans/${encodeURIComponent(plan.id)}`,
      { method: 'PUT', body }
    ));
    planWriteQueue = write.catch(() => {});
    const saved = await write;
    const index = plans.findIndex(value => value.id === saved.id);
    if (index !== -1) plans[index] = saved;
    renderDashboard();
    expandedDays = openDays;
    renderPlanDetail();
  } catch (error) {
    item.is_completed = previousValue;
    expandedDays = openDays;
    renderPlanDetail();
    toast(`Progress was not saved: ${error.message}`);
  }
}

async function deletePlan(planId) {
  if (!window.confirm('Delete this plan and all its progress? This cannot be undone.')) return;
  try {
    await request(`/api/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' });
    plans = plans.filter(plan => plan.id !== planId);
    selectedPlanId = null;
    renderDashboard();
    showPage('home');
    toast('Plan deleted');
  } catch (error) {
    toast(`Could not delete plan: ${error.message}`);
  }
}

async function loadPlans() {
  plans = await request('/api/plans');
  renderDashboard();
}

async function authenticate(event) {
  event.preventDefault();
  const button = $('#auth-submit');
  button.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const credentials = {
      email: $('#auth-email').value.trim(),
      password: $('#auth-password').value
    };
    if (authMode === 'register') credentials.display_name = $('#auth-name').value.trim();
    const result = await request(path, {
      method: 'POST',
      body: JSON.stringify(credentials)
    });
    token = result.token;
    user = result.user;
    localStorage.setItem(TOKEN_KEY, token);
    await loadPlans();
    showApp();
  } catch (error) {
    $('#auth-error').textContent = error.message;
  } finally {
    button.disabled = !API_BASE;
  }
}

async function restoreSession() {
  if (!API_BASE) {
    showAuth();
    return;
  }
  if (!token) {
    showAuth();
    return;
  }
  try {
    user = await request('/api/auth/me');
    await loadPlans();
    showApp();
  } catch (error) {
    if (token) {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      showAuth(error.message);
    }
  }
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3000);
}

$('#auth-form').addEventListener('submit', authenticate);
$('#auth-mode-toggle').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  showAuth();
});
$('#logout-btn').addEventListener('click', async () => {
  let message = 'Signed out';
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    message = `Signed out on this device; server logout failed: ${error.message}`;
  }
  token = '';
  user = null;
  plans = [];
  localStorage.removeItem(TOKEN_KEY);
  authMode = 'login';
  showAuth();
  toast(message);
});
$$('.nav-item').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
$$('[data-create-plan]').forEach(button => button.addEventListener('click', () => beginPlanEditor()));
$('#plan-grid').addEventListener('click', event => {
  const button = event.target.closest('[data-open-plan]');
  if (!button) return;
  selectedPlanId = button.dataset.openPlan;
  expandedDays = new Set();
  renderPlanDetail();
  showPage('plans');
});
$('#plan-grid').addEventListener('click', event => {
  if (event.target.closest('[data-create-plan]')) beginPlanEditor();
});
$('#plan-detail').addEventListener('click', event => {
  const toggle = event.target.closest('[data-toggle-day]');
  const edit = event.target.closest('[data-edit-plan]');
  const remove = event.target.closest('[data-delete-plan]');
  if (toggle) {
    const id = toggle.dataset.toggleDay;
    if (expandedDays.has(id)) expandedDays.delete(id);
    else expandedDays.add(id);
    renderPlanDetail();
  } else if (edit) {
    const plan = plans.find(item => item.id === edit.dataset.editPlan);
    if (plan) beginPlanEditor(plan);
  } else if (remove) {
    deletePlan(remove.dataset.deletePlan);
  } else if (event.target.closest('[data-go-home]')) {
    showPage('home');
  }
});
$('#plan-detail').addEventListener('change', event => {
  if (event.target.matches('[data-checklist-id]')) toggleChecklist(event.target);
});
$('#set-days-btn').addEventListener('click', () => resizeDays($('#builder-day-count').value));
$('#builder-days').addEventListener('input', event => {
  const element = event.target;
  if (element.matches('[data-day-title]')) {
    draft.days.find(day => day.id === element.dataset.dayTitle).title = element.value;
  } else if (element.matches('[data-topic-title]')) {
    for (const day of draft.days) {
      const topic = day.topics.find(item => item.id === element.dataset.topicTitle);
      if (topic) topic.title = element.value;
    }
  } else if (element.matches('[data-checklist-title]')) {
    for (const day of draft.days) {
      for (const topic of day.topics) {
        const item = topic.checklist.find(value => value.id === element.dataset.checklistTitle);
        if (item) item.title = element.value;
      }
    }
  }
});
$('#builder-days').addEventListener('change', event => {
  const element = event.target;
  if (element.matches('[data-topic-count]')) {
    updateTopicCount(element.dataset.topicCount, element.value);
  } else if (element.matches('[data-checklist-count]')) {
    updateChecklistCount(
      element.dataset.checklistCount,
      element.dataset.countTopicId,
      element.value
    );
  }
});
function handleCountStep(event) {
  const button = event.target.closest('[data-step]');
  if (!button) return;
  const stepper = button.closest('.stepper');
  const input = stepper?.querySelector('input[type="number"]');
  if (!input) return;
  const min = Number(input.min);
  const max = Number(input.max);
  const next = Math.min(max, Math.max(min, Number(input.value) + Number(button.dataset.step)));
  if (next === Number(input.value)) return;
  const key = {
    id: input.id,
    topicDay: input.dataset.topicCount,
    checklistDay: input.dataset.checklistCount,
    checklistTopic: input.dataset.countTopicId
  };
  input.value = String(next);
  if (input.id === 'builder-day-count') {
    resizeDays(next);
  } else {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const inputs = [...document.querySelectorAll('.stepper input[type="number"]')];
  const replacement = inputs.find(candidate =>
    (key.id && candidate.id === key.id)
    || (key.topicDay && candidate.dataset.topicCount === key.topicDay)
    || (key.checklistDay && candidate.dataset.checklistCount === key.checklistDay
      && candidate.dataset.countTopicId === key.checklistTopic)
  );
  replacement?.focus();
}
$('#editor-basics').addEventListener('click', handleCountStep);
$('#builder-days').addEventListener('click', handleCountStep);
$('#plan-editor-form').addEventListener('submit', savePlan);
$('#builder-name').addEventListener('input', event => {
  if (draft) draft.name = event.target.value;
});
$('#builder-day-count').addEventListener('change', event => resizeDays(event.target.value));
$('#cancel-editor-btn').addEventListener('click', () => {
  if (selectedPlanId) {
    renderPlanDetail();
    showPage('plans');
  } else {
    showPage('home');
  }
});
$('#menu-btn').addEventListener('click', () => {
  if ($('#app-sidebar').classList.contains('open')) closeSidebar();
  else openSidebar();
});
$('#sidebar-close-btn').addEventListener('click', closeSidebar);
$('#sidebar-backdrop').addEventListener('click', closeSidebar);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#app-sidebar').classList.contains('open')) {
    closeSidebar();
  }
});

let deferredInstallPrompt = null;
const installButton = $('#install-btn');
installButton.hidden = true;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.hidden = true;
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(error => {
    console.error('Service worker registration failed:', error);
  });
}
restoreSession();
