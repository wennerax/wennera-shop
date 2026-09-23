const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';
const state = { config: null, user: null, requests: [], messages: [] };
const $ = (selector) => document.querySelector(selector);

function haptic(type = 'light') { tg?.HapticFeedback?.impactOccurred(type); }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2800); }
function api(path, options = {}) { return fetch(path, { ...options, headers: { ...(options.headers || {}), 'X-Telegram-Init-Data': initData } }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Что-то пошло не так'); return data; }); }

function switchView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name));
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === name));
  haptic(); window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openDirectMessage() {
  switchView('messages');
  $('#direct-title').focus();
  haptic('medium');
}

function openForm(type) {
  switchView('form'); $('#form-type').value = type;
  const data = { order: ['NEW ORDER', 'Заказать бота', 'Опиши идею, а я вернусь с оценкой и планом.', true], bug: ['BUG REPORT', 'Нашёл баг?', 'Чем точнее детали, тем быстрее я его поймаю.', true] }[type];
  $('#form-kicker').textContent = data[0]; $('#form-title').textContent = data[1]; $('#form-intro').textContent = data[2]; $('#bot-name-label').style.display = type === 'bug' ? 'grid' : 'none'; $('#budget-label').style.display = type === 'order' ? 'grid' : 'none';
}

function renderRequests() {
  $('#request-count').textContent = state.requests.length; $('#stat-total').textContent = state.requests.length;
  const list = $('#request-list'); $('#empty-state').style.display = state.requests.length ? 'none' : 'block';
  list.innerHTML = state.requests.map((request) => `<article class="request"><div class="request-top"><span class="tag">${request.type === 'bug' ? 'BUG REPORT' : request.type === 'order' ? 'ORDER' : 'MESSAGE'}</span><span>${new Date(request.created_at).toLocaleDateString('ru-RU')}</span></div><h3>${escapeHtml(request.title)}</h3><p>${escapeHtml(request.details)}</p></article>`).join('');
}
function renderMessages() {
  $('#direct-history').innerHTML = state.messages.map((message) => `<article class="direct-thread"><div class="direct-message"><span>ТЫ</span><strong>${escapeHtml(message.title)}</strong><p>${escapeHtml(message.details)}</p></div>${message.reply_text ? `<div class="direct-reply"><span>WENNERA</span><p>${escapeHtml(message.reply_text)}</p><small>${new Date(message.replied_at).toLocaleString('ru-RU')}</small></div>` : '<div class="direct-waiting">Ожидает ответа</div>'}</article>`).join('');
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[char]); }

document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.nav)));
document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => button.dataset.open === 'message' ? openDirectMessage() : openForm(button.dataset.open)));
$('#back-button').addEventListener('click', () => switchView('home'));
$('#direct-back').addEventListener('click', () => switchView('home'));
$('#fullscreen').addEventListener('click', () => { tg?.requestFullscreen?.(); tg?.expand?.(); haptic('medium'); });
$('#request-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = 'Отправляю...';
  try { const response = await api('/api/requests', { method: 'POST', body: new FormData(event.target) }); showToast(response.preview ? 'Preview: заявка готова к отправке' : 'Заявка принята. Я скоро отвечу.'); event.target.reset(); switchView('requests'); await loadData(); haptic('medium'); }
  catch (error) { showToast(error.message); } finally { button.disabled = false; button.innerHTML = 'Отправить заявку <span>↗</span>'; }
});
$('#direct-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = 'Отправляю...';
  try { const response = await api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('#direct-title').value, details: $('#direct-details').value }) }); showToast(response.preview ? 'Preview: сообщение готово к отправке' : 'Сообщение отправлено.'); event.target.reset(); await loadData(); haptic('medium'); }
  catch (error) { showToast(error.message); } finally { button.disabled = false; button.innerHTML = 'Отправить сообщение <span>↗</span>'; }
});

async function loadData() {
  state.config = await api('/api/config'); $('#owner-name').textContent = state.config.owner.name; $('#owner-bio').textContent = state.config.owner.bio;
  const data = await api('/api/me'); state.user = data.user; state.requests = data.requests; state.messages = data.messages; const fullName = [data.user.first_name, data.user.last_name].filter(Boolean).join(' '); $('#profile-name').textContent = fullName; $('#profile-handle').textContent = data.user.username ? `@${data.user.username}` : 'личный профиль'; const avatar = $('#profile-avatar'); avatar.textContent = (data.user.first_name || 'P')[0].toUpperCase(); if (data.user.photo_url) { avatar.innerHTML = `<img src="${escapeHtml(data.user.photo_url)}" alt="Аватар ${escapeHtml(fullName)}">`; avatar.classList.add('has-image'); } $('#profile-badges').textContent = data.user.is_premium ? '✦ Telegram Premium' : ''; $('#profile-bio').textContent = data.user.bio || ''; $('#profile-note').style.display = data.user.bio ? 'none' : 'block'; $('#profile-id').textContent = data.user.id; $('#profile-language').textContent = data.user.language_code || 'не указан'; renderRequests(); renderMessages();
}

tg?.ready(); tg?.expand(); tg?.setHeaderColor?.('#0b0d0f'); tg?.setBackgroundColor?.('#0b0d0f');
loadData().catch(() => showToast('Открой приложение через Telegram или проверь сервер.'));