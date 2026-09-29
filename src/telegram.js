import crypto from 'node:crypto';
import fs from 'node:fs';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { createMessage, getMessageById, getMessageByOwnerMessageId, saveMessageReply, setOwnerMessageId, upsertUser } from './db.js';
import { registerAdminCommands } from './admin-commands.js';
import { generateAssistantReply, sendWithEmoji } from './assistant.js';
import { copyBusinessMediaToChat, describeMessageMedia } from './telegram-media.js';
import { getValidWebAppUrl, isIncomingBusinessMessage } from './telegram-utils.js';

function reportBusinessErrorOnce(loggedErrors, error) {
  const key = String(error.error_code || error.description || error.message);
  if (loggedErrors.has(key)) return;
  loggedErrors.add(key);
  console.error('Business API response unavailable:', error.description || error.message);
}

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
  const businessTargets = new Map();
  const pendingBusinessReplies = new Map();
  const loggedBusinessErrors = new Set();
  const activeSpamTests = new Set();
  const webAppUrl = getValidWebAppUrl(appUrl);
  const keyboard = webAppUrl ? new InlineKeyboard().webApp('Открыть ассистента', webAppUrl) : undefined;
  const hasBusinessReplyAccess = (connection) => {
    if (!connection?.is_enabled || String(connection.user?.id) !== String(adminId)) return false;
    return connection.rights?.can_reply !== false;
  };
  const validateBusinessConnection = async (connectionId) => {
    try {
      const connection = await bot.api.getBusinessConnection(connectionId);
      if (!hasBusinessReplyAccess(connection)) {
        return 'Ответ недоступен: проверь подключение и право Business-бота отвечать.';
      }
      return null;
    } catch (error) {
      reportBusinessErrorOnce(loggedBusinessErrors, error);
      return `Business-подключение недоступно: ${error.description || error.message}`;
    }
  };
  const sendBusinessReply = async (userId, text, preferredTarget = null) => {
    const target = preferredTarget || businessTargets.get(String(userId));
    if (!target) return null;
    try {
      const connectionError = await validateBusinessConnection(target.connectionId);
      if (connectionError) {
        businessTargets.delete(String(userId));
        return connectionError;
      }
      await sendWithEmoji((message, options) => bot.api.sendMessage(target.chatId, message, options), text, {
        business_connection_id: target.connectionId
      });
      return 'Ответ отправлен от имени Business-аккаунта.';
    } catch (error) {
      reportBusinessErrorOnce(loggedBusinessErrors, error);
      return `Business-ответ не отправлен: ${error.description || error.message}`;
    }
  };
  const startSpamTest = (targetId, count, text, preferredTarget = null) => {
    const targetKey = String(targetId);
    if (!Number.isInteger(count) || count < 1 || count > 100) return { error: 'Количество тестовых сообщений должно быть от 1 до 100.' };
    if (!text?.trim()) return { error: 'Добавь текст тестового сообщения.' };
    if (activeSpamTests.size) return { error: 'Другой тест уже запущен. Дождись его завершения.' };
    activeSpamTests.add(targetKey);
    const promise = (async () => {
      let sent = 0;
      try {
        const target = preferredTarget || businessTargets.get(targetKey);
        if (target) {
          const connection = await bot.api.getBusinessConnection(target.connectionId);
          if (!hasBusinessReplyAccess(connection)) {
            return 'Тест остановлен: для Business-чата нужно активное подключение с правом can_reply.';
          }
        }
        for (let index = 0; index < count; index += 1) {
          if (target) await bot.api.sendMessage(target.chatId, text, { business_connection_id: target.connectionId });
          else await bot.api.sendMessage(targetKey, text);
          sent += 1;
          if (sent < count) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return `Тест завершён: отправлено ${sent} из ${count} сообщений в чат ${targetKey}.`;
      } catch (error) {
        return `Тест остановлен после ${sent} из ${count}: ${error.description || error.message}`;
      } finally {
        activeSpamTests.delete(targetKey);
      }
    })();
    return { promise };
  };
  registerAdminCommands(bot, { ownerId: adminId, appUrl, sendBusinessReply, startSpamTest, validateBusinessConnection });
  bot.command('start', (ctx) => ctx.reply('Привет! Здесь можно связаться с Wennera, заказать бота или оставить заявку на баг.', keyboard ? { reply_markup: keyboard } : undefined));
  bot.command('id', (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}${ctx.from.username ? `\nUsername: @${ctx.from.username}` : '\nUsername не задан'}\nВладелец настроен правильно: ${String(ctx.from.id) === String(adminId) ? 'да' : 'нет'}`));
  bot.command('app', (ctx) => ctx.reply(keyboard ? 'Открывай Mini App:' : 'Mini App временно недоступно: требуется публичный HTTPS APP_URL.', keyboard ? { reply_markup: keyboard } : undefined));
  bot.callbackQuery(/^reply:(\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== String(adminId)) return ctx.answerCallbackQuery({ text: 'Недостаточно прав', show_alert: true });
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
  bot.callbackQuery(/^bizreply:(-?\d+)$/, async (ctx) => {
    if (String(ctx.from.id) !== String(adminId)) return ctx.answerCallbackQuery({ text: 'Недостаточно прав', show_alert: true });
    const businessChatId = String(ctx.match[1]);
    if (!businessTargets.has(businessChatId)) return ctx.answerCallbackQuery({ text: 'Диалог больше недоступен' });
    await ctx.answerCallbackQuery({ text: 'Напиши ответ текстом' });
    const prompt = await bot.api.sendMessage(String(adminId), 'Напиши ответ для Business-диалога.', {
      reply_markup: { force_reply: true, input_field_placeholder: 'Текст ответа...' }
    });
    pendingBusinessReplies.set(prompt.message_id, businessChatId);
  });
  bot.on('message', async (ctx) => {
    if (ctx.message.text?.startsWith('/') || ctx.message.text?.startsWith('*')) return;
    const isAdmin = String(ctx.from.id) === String(adminId);
    if (isAdmin && ctx.message.reply_to_message?.message_id) {
      const businessChatId = pendingBusinessReplies.get(ctx.message.reply_to_message.message_id);
      if (businessChatId) {
        const replyText = ctx.message.text?.trim();
        if (!replyText) {
          await ctx.reply('Ответ для Business-диалога нужно отправить текстом.');
          return;
        }
        const result = await sendBusinessReply(businessChatId, replyText);
        pendingBusinessReplies.delete(ctx.message.reply_to_message.message_id);
        await sendWithEmoji((text, options) => ctx.reply(text, options), result);
        return;
      }
      const replyTargetIds = [
        ctx.message.reply_to_message.message_id,
        ctx.message.reply_to_message.reply_to_message?.message_id
      ].filter(Boolean);
      const message = replyTargetIds.map((id) => getMessageByOwnerMessageId(id)).find(Boolean)
        || getMessageByOwnerMessageId(pendingReplies.get(ctx.message.reply_to_message.message_id));
      if (message) {
        const replyText = ctx.message.text?.trim() || ctx.message.caption?.trim() || '[Медиа-ответ Wennera]';
        try {
          if (ctx.message.text?.trim()) {
            await sendWithEmoji((text, options) => bot.api.sendMessage(message.telegram_id, text, options), `Ответ Wennera:\n\n${replyText}`);
          } else {
            await bot.api.copyMessage(message.telegram_id, ctx.chat.id, ctx.message.message_id);
          }
        } catch (error) {
          await ctx.reply(`Не удалось отправить ответ: ${error.description || error.message}`);
          return;
        }
        saveMessageReply(message.id, replyText);
        pendingReplies.delete(ctx.message.reply_to_message.message_id);
        await sendWithEmoji((text, options) => ctx.reply(text, options), 'Ответ отправлен пользователю.');
        return;
      }
    }
    if (isAdmin) return;
    if (ctx.chat.type !== 'private') return;
    upsertUser({ id: String(ctx.from.id), first_name: ctx.from.first_name, last_name: ctx.from.last_name ?? null, username: ctx.from.username ?? null, photo_url: null });
    const isMedia = !ctx.message.text;
    const mediaLabel = isMedia ? describeMessageMedia(ctx.message) : '';
    const text = ctx.message.text?.trim() || ctx.message.caption?.trim() || `[${mediaLabel}]`;
    const id = createMessage({ telegram_id: String(ctx.from.id), title: 'Сообщение в Telegram', details: text });
    if (adminId) {
      const identity = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
      const username = ctx.from.username ? ` (@${ctx.from.username})` : '';
      try {
        const notification = await sendWithEmoji((message, options) => bot.api.sendMessage(adminId, message, options), `📩 Новое сообщение\n${identity || 'Пользователь'}${username} · ID ${ctx.from.id}\n${text.slice(0, 2500)}${isMedia ? '\n\nОтветь на пересланное медиа или нажми «Ответить».' : ''}`, {
          reply_markup: { inline_keyboard: [[{ text: 'Ответить', callback_data: `reply:${id}` }]] }
        });
        setOwnerMessageId(id, notification.message_id);
        if (isMedia) {
          try {
            const forwarded = await bot.api.forwardMessage(adminId, ctx.chat.id, ctx.message.message_id);
            setOwnerMessageId(id, forwarded.message_id);
          } catch (error) {
            console.error('Incoming media forwarding failed:', error.message);
          }
        }
      } catch (error) {
        console.error('Private message notification failed:', error.message);
      }
    }
    let answer = 'Сообщение получил и передал Wennera. Для заявки с подробностями открой Mini App.';
    const assistantInput = ctx.message.text || ctx.message.caption;
    if (process.env.AI_API_KEY && assistantInput) {
      try {
        answer = await generateAssistantReply(assistantInput) || answer;
      } catch (error) {
        console.error('Assistant reply failed:', error.message);
      }
    }
    await sendWithEmoji((text, options) => ctx.reply(text, options), answer, { reply_markup: keyboard });
  });
  bot.on('business_message', async (ctx) => {
    const message = ctx.update.business_message;
    if (!isIncomingBusinessMessage(message, adminId)) return;
    let connection;
    try {
      connection = await bot.api.getBusinessConnection(message.business_connection_id);
    } catch (error) {
      reportBusinessErrorOnce(loggedBusinessErrors, error);
      return;
    }
    if (!hasBusinessReplyAccess(connection)) return;
    const canReply = hasBusinessReplyAccess(connection);
    if (canReply) businessTargets.set(String(message.chat.id), { connectionId: message.business_connection_id, chatId: message.chat.id });
    else businessTargets.delete(String(message.chat.id));
    upsertUser({ id: String(message.chat.id), first_name: message.from.first_name, last_name: message.from.last_name ?? null, username: message.from.username ?? null, photo_url: null });
    const text = message.text?.trim() || message.caption?.trim() || '[Пользователь отправил вложение]';
    if (adminId && process.env.BUSINESS_NOTIFICATIONS !== 'false') {
      try {
        const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') || 'Контакт';
        const username = message.from.username ? ` (@${message.from.username})` : '';
        const preview = (message.text || message.caption || `📎 ${describeMessageMedia(message)}`).replace(/\s+/g, ' ').slice(0, 180);
        await bot.api.sendMessage(adminId, `💬 ${name}${username} · ID ${message.chat.id}\n${preview}`, canReply ? {
          reply_markup: { inline_keyboard: [[{ text: 'Ответить', callback_data: `bizreply:${message.chat.id}` }]] }
        } : {});
        if (!message.text) {
          const copied = await copyBusinessMediaToChat(bot, adminId, message);
          if (!copied) console.info(`Business media not copied: ${describeMessageMedia(message)}`);
        }
      } catch (error) {
        console.error('Business message notification failed:', error.message);
      }
    }
    if (!canReply) return;
    let answer = 'Это автоответ цифрового ассистента Wennera: сообщение получено, владелец ответит позже.';
    if (process.env.AI_API_KEY && message.text) {
      try {
        answer = await generateAssistantReply(message.text) || answer;
      } catch (error) {
        console.error('Business assistant reply failed:', error.message);
      }
    }
    try {
      await sendWithEmoji((text, options) => bot.api.sendMessage(message.chat.id, text, options), answer, {
        business_connection_id: message.business_connection_id,
        reply_parameters: { message_id: message.message_id }
      });
    } catch (error) {
      reportBusinessErrorOnce(loggedBusinessErrors, error);
    }
  });
  if (webAppUrl) {
    bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Ассистент', web_app: { url: webAppUrl } } }).catch(console.error);
  }
  bot.api.deleteWebhook({ drop_pending_updates: false })
    .then(() => bot.start({ allowed_updates: ['message', 'callback_query', 'business_connection', 'business_message'] }))
    .catch((error) => console.error('Telegram polling failed:', error.description || error.message));
  return { notify: async (request, user, mediaPath) => {
    if (!adminId) return;
    const label = { bug: 'Баг-репорт', order: 'Новый заказ', message: 'Новое сообщение' }[request.type];
    const identity = [user.first_name, user.last_name].filter(Boolean).join(' ') + (user.username ? ` (@${user.username})` : '');
    const text = `⚡ ${label}\nПользователь: ${identity}\nID: ${user.id}\n${request.title}\n\n${request.details}${request.bot_name ? `\n\nБот: ${request.bot_name}` : ''}${request.budget ? `\nБюджет: ${request.budget} ₽` : ''}`;
    const replyButton = request.type === 'message'
      ? { inline_keyboard: [[{ text: 'Ответить', callback_data: `reply:${request.id}` }]] }
      : undefined;
    const sendOptions = replyButton ? { reply_markup: replyButton } : {};
    const sent = mediaPath && fs.existsSync(mediaPath)
      ? await sendWithEmoji((caption, options) => {
        const { entities, ...documentOptions } = options;
        return bot.api.sendDocument(adminId, new InputFile(mediaPath), {
          ...documentOptions,
          caption,
          ...(entities ? { caption_entities: entities } : {})
        });
      }, text, sendOptions)
      : await sendWithEmoji((message, options) => bot.api.sendMessage(adminId, message, options), text, sendOptions);
    if (request.id) setOwnerMessageId(request.id, sent.message_id);
  }};
}