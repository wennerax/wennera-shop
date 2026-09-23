const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';
const state = { config: null, user: null, requests: [] };
const $ = (selector) => document.querySelector(selector);

function haptic(type = 'light') { tg?.HapticFeedback?.impactOccurred(type); }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2800); }
function api(path, options = {}) { return fetch(path, { ...options, headers: { ...(options.headers || {}), 'X-Telegram-Init-Data': initData } }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Что-то пошло не так'); return data; }); }

function switchView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name));
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === name));
  haptic(); window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openForm(type) {
  switchView('form'); $('#form-type').value = type;
  const data = { order: ['NEW ORDER', 'Заказать бота', 'Опиши идею, а я вернусь с оценкой и планом.', true], bug: ['BUG REPORT', 'Нашёл баг?', 'Чем точнее детали, тем быстрее я его поймаю.', true], message: ['DIRECT LINE', 'Написать мне', 'Любой вопрос, идея или предложение.', false] }[type];
  $('#form-kicker').textContent = data[0]; $('#form-title').textContent = data[1]; $('#form-intro').textContent = data[2]; $('#bot-name-label').style.display = type === 'bug' ? 'grid' : 'none'; $('#budget-label').style.display = type === 'order' ? 'grid' : 'none';
}

function renderRequests() {
  $('#request-count').textContent = state.requests.length; $('#stat-total').textContent = state.requests.length;
  const list = $('#request-list'); $('#empty-state').style.display = state.requests.length ? 'none' : 'block';
  list.innerHTML = state.requests.map((request) => `<article class="request"><div class="request-top"><span class="tag">${request.type === 'bug' ? 'BUG REPORT' : request.type === 'order' ? 'ORDER' : 'MESSAGE'}</span><span>${new Date(request.created_at).toLocaleDateString('ru-RU')}</span></div><h3>${escapeHtml(request.title)}</h3><p>${escapeHtml(request.details)}</p></article>`).join('');
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[char]); }

document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.nav)));
document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => openForm(button.dataset.open)));
$('#back-button').addEventListener('click', () => switchView('home'));
$('#fullscreen').addEventListener('click', () => { tg?.requestFullscreen?.(); tg?.expand?.(); haptic('medium'); });
$('#request-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = 'Отправляю...';
  try { const response = await api('/api/requests', { method: 'POST', body: new FormData(event.target) }); showToast(response.preview ? 'Preview: заявка готова к отправке' : 'Заявка принята. Я скоро отвечу.'); event.target.reset(); switchView('requests'); await loadData(); haptic('medium'); }
  catch (error) { showToast(error.message); } finally { button.disabled = false; button.innerHTML = 'Отправить заявку <span>↗</span>'; }
});

async function loadData() {
  state.config = await api('/api/config'); $('#owner-name').textContent = state.config.owner.name; $('#owner-bio').textContent = state.config.owner.bio;
  const data = await api('/api/me'); state.user = data.user; state.requests = data.requests; const fullName = [data.user.first_name, data.user.last_name].filter(Boolean).join(' '); $('#profile-name').textContent = fullName; $('#profile-handle').textContent = data.user.username ? `@${data.user.username}` : 'личный профиль'; $('#profile-avatar').textContent = (data.user.first_name || 'P')[0].toUpperCase(); $('#profile-id').textContent = data.user.id; renderRequests();
}

tg?.ready(); tg?.expand(); tg?.setHeaderColor?.('#0b0d0f'); tg?.setBackgroundColor?.('#0b0d0f');
loadData().catch(() => showToast('Открой приложение через Telegram или проверь сервер.'));