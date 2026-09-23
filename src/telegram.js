import crypto from 'node:crypto';
import fs from 'node:fs';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { getMessageById, getMessageByOwnerMessageId, saveMessageReply, setOwnerMessageId, upsertUser } from './db.js';

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
  const pendingReplies = new Map();
  const authorizedOwners = new Set(adminId ? [String(adminId)] : []);
  const keyboard = new InlineKeyboard().webApp('Открыть ассистента', appUrl);
  bot.command('start', (ctx) => ctx.reply('Привет! Здесь можно связаться с Wennera, заказать бота или оставить заявку на баг.', { reply_markup: keyboard }));
  bot.command('app', (ctx) => ctx.reply('Открывай Mini App:', { reply_markup: keyboard }));
  bot.callbackQuery(/^reply:(\d+)$/, async (ctx) => {
    authorizedOwners.add(String(ctx.from.id));
    const message = getMessageById(Number(ctx.match[1]));
    if (!message?.owner_message_id) return ctx.answerCallbackQuery({ text: 'Сообщение уже недоступно' });
    const ownerMessageId = message.owner_message_id;
    const replyAdminId = String(ctx.from.id);
    await ctx.answerCallbackQuery({ text: 'Напиши ответ пользователю' });
    const prompt = await bot.api.sendMessage(replyAdminId, 'Напиши ответ пользователю и отправь его ответом на это сообщение.', {
      reply_parameters: { message_id: ownerMessageId },
      reply_markup: { force_reply: true, input_field_placeholder: 'Текст ответа...' }
    });
    pendingReplies.set(prompt.message_id, ownerMessageId);
  });
  bot.on('message', async (ctx) => {
    if (ctx.message.text?.startsWith('/')) return;
    const isAdmin = authorizedOwners.has(String(ctx.from.id));
    if (isAdmin && ctx.message.reply_to_message?.message_id) {
      const replyTargetIds = [
        ctx.message.reply_to_message.message_id,
        ctx.message.reply_to_message.reply_to_message?.message_id
      ].filter(Boolean);
      const message = replyTargetIds.map((id) => getMessageByOwnerMessageId(id)).find(Boolean)
        || getMessageByOwnerMessageId(pendingReplies.get(ctx.message.reply_to_message.message_id));
      if (message && ctx.message.text?.trim()) {
        await bot.api.sendMessage(message.telegram_id, `Ответ Wennera:\n\n${ctx.message.text.trim()}`);
        saveMessageReply(message.id, ctx.message.text.trim());
        pendingReplies.delete(ctx.message.reply_to_message.message_id);
        await ctx.reply('Ответ отправлен пользователю.');
        return;
      }
    }
    if (isAdmin) return;
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
    const replyButton = request.type === 'message'
      ? { inline_keyboard: [[{ text: 'Ответить', callback_data: `reply:${request.id}` }]] }
      : undefined;
    const sent = mediaPath && fs.existsSync(mediaPath)
      ? await bot.api.sendDocument(adminId, new InputFile(mediaPath), { caption: text, ...(replyButton ? { reply_markup: replyButton } : {}) })
      : await bot.api.sendMessage(adminId, text, replyButton ? { reply_markup: replyButton } : undefined);
    if (request.id) setOwnerMessageId(request.id, sent.message_id);
  }};
}