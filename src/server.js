import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { createMessage, createRequest, getUserMessages, getUserRequests, upsertUser } from './db.js';
import { startBot, validateInitData } from './telegram.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const uploadsDir = path.resolve('uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, /^(image|video|application\/pdf)$/.test(file.mimetype))
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.resolve('public')));

const demoUser = { id: 'preview', first_name: 'Preview', last_name: null, username: null, photo_url: null, language_code: 'ru', is_premium: false, bio: null, profile_music: null };
function auth(req, res, next) {
  const user = validateInitData(req.headers['x-telegram-init-data'], process.env.BOT_TOKEN);
  if (user) {
    const normalized = { id: String(user.id), first_name: user.first_name, last_name: user.last_name ?? null, username: user.username ?? null, photo_url: user.photo_url ?? null, language_code: user.language_code ?? null, is_premium: Boolean(user.is_premium), bio: null, profile_music: null };
    upsertUser(normalized);
    req.user = normalized;
    return next();
  }
  if (!process.env.BOT_TOKEN && process.env.NODE_ENV !== 'production') {
    req.user = demoUser;
    return next();
  }
  return res.status(401).json({ error: 'Откройте приложение внутри Telegram.' });
}

const ownerId = process.env.OWNER_TELEGRAM_ID || process.env.ADMIN_TELEGRAM_ID;
const bot = startBot({ token: process.env.BOT_TOKEN, appUrl, adminId: ownerId || '7288555779' });

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

app.get('/api/config', (_req, res) => res.json({
  owner: { name: process.env.OWNER_DISPLAY_NAME || 'Wennera', username: process.env.OWNER_USERNAME || 'dissociation_n', bio: process.env.OWNER_BIO || 'Создаю ботов и Mini Apps' },
  minOrderPrice: Number(process.env.MIN_ORDER_PRICE || 2500),
  botUsername: process.env.BOT_USERNAME || ''
}));

app.get('/api/me', auth, (req, res) => res.json({
  user: req.user,
  requests: req.user.id === 'preview' ? [] : getUserRequests(req.user.id),
  messages: req.user.id === 'preview' ? [] : getUserMessages(req.user.id)
}));

app.post('/api/requests', auth, upload.single('media'), async (req, res) => {
  const { type, title, details, botName, budget } = req.body;
  const allowedTypes = new Set(['bug', 'order']);
  if (!allowedTypes.has(type) || !title?.trim() || !details?.trim()) return res.status(400).json({ error: 'Заполните обязательные поля.' });
  const minPrice = Number(process.env.MIN_ORDER_PRICE || 2500);
  const numericBudget = budget ? Number(budget) : null;
  if (type === 'order' && (!numericBudget || numericBudget < minPrice)) return res.status(400).json({ error: `Минимальный бюджет заказа — ${minPrice} ₽.` });
  if (req.user.id === 'preview') return res.json({ ok: true, preview: true });
  const request = { telegram_id: req.user.id, type, title: title.trim(), details: details.trim(), bot_name: botName?.trim() || null, budget: numericBudget, media_path: req.file?.path || null };
  const id = createRequest(request);
  try { await bot?.notify(request, req.user, req.file?.path); } catch (error) { console.error('Telegram notification failed:', error.message); }
  return res.status(201).json({ ok: true, id });
});

app.post('/api/messages', auth, async (req, res) => {
  const { title, details } = req.body;
  if (!title?.trim() || !details?.trim()) return res.status(400).json({ error: 'Напиши тему и сообщение.' });
  if (req.user.id === 'preview') return res.json({ ok: true, preview: true });
  const message = { telegram_id: req.user.id, title: title.trim(), details: details.trim() };
  const id = createMessage(message);
  try { await bot?.notify({ ...message, id, type: 'message' }, req.user); } catch (error) { console.error('Telegram message notification failed:', error.message); }
  return res.status(201).json({ ok: true, id });
});

app.use((_req, res) => res.sendFile(path.resolve('public/index.html')));
app.listen(port, () => console.log(`Wennera Assistant listening on ${appUrl}`));