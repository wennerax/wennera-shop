import crypto from 'node:crypto';
import fs from 'node:fs';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { upsertUser } from './db.js';

export function validateInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (receivedHash.length !== expectedHash.length || !crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash))) return null;
  const user = params.get('user');
  return user ? JSON.parse(user) : null;
}

export function startBot({ token, appUrl, adminId }) {
  if (!token) return null;
  const bot = new Bot(token);
  const keyboard = new InlineKeyboard().webApp('Открыть ассистента', appUrl);
  bot.command('start', (ctx) => ctx.reply('Привет! Здесь можно связаться с Wennera, заказать бота или оставить заявку на баг.', { reply_markup: keyboard }));
  bot.command('app', (ctx) => ctx.reply('Открывай Mini App:', { reply_markup: keyboard }));
  bot.on('message', async (ctx) => {
    if (ctx.message.text?.startsWith('/')) return;
    upsertUser({ id: String(ctx.from.id), first_name: ctx.from.first_name, last_name: ctx.from.last_name ?? null, username: ctx.from.username ?? null, photo_url: null });
    await ctx.reply('Сообщение принято. Для заявки с деталями открой Mini App.', { reply_markup: keyboard });
  });
  bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Ассистент', web_app: { url: appUrl } } }).catch(console.error);
  bot.start().catch(console.error);
  return { notify: async (request, user, mediaPath) => {
    if (!adminId) return;
    const label = { bug: 'Баг-репорт', order: 'Новый заказ', message: 'Новое сообщение' }[request.type];
    const identity = [user.first_name, user.last_name].filter(Boolean).join(' ') + (user.username ? ` (@${user.username})` : '');
    const text = `⚡ ${label}\nПользователь: ${identity}\nID: ${user.id}\n${request.title}\n\n${request.details}${request.bot_name ? `\n\nБот: ${request.bot_name}` : ''}${request.budget ? `\nБюджет: ${request.budget} ₽` : ''}`;
    if (mediaPath && fs.existsSync(mediaPath)) await bot.api.sendDocument(adminId, new InputFile(mediaPath), { caption: text });
    else await bot.api.sendMessage(adminId, text);
  }};
}