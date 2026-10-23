import { formatDuration, getHostStatus } from './host-status.js';
import { resolveCustomEmojiEntities, sendWithEmoji } from './assistant.js';
import { getOwnerProfile, getUserByUsername, saveOwnerProfile } from './db.js';
import { getValidWebAppUrl } from './telegram-utils.js';

const profileDrafts = new Map();
const profileFields = [
  { key: 'name', label: 'Имя', prompt: 'Как указать имя или псевдоним?', maxLength: 100 },
  { key: 'role', label: 'Роль', prompt: 'Твоя роль или специализация?', maxLength: 140 },
  { key: 'about', label: 'О себе', prompt: 'Коротко расскажи о себе.', maxLength: 700 },
  { key: 'skills', label: 'Навыки', prompt: 'Перечисли навыки или услуги.', maxLength: 500 },
  { key: 'contacts', label: 'Контакты', prompt: 'Добавь контакты и ссылки (или отправь - чтобы пропустить).', maxLength: 500 }
];

const profileStyles = {
  bold: 'bold', italic: 'italic', underline: 'underline', spoiler: 'spoiler', code: 'code'
};

function profileKeyboard() {
  const rows = [];
  for (let index = 0; index < profileFields.length; index += 2) {
    rows.push(profileFields.slice(index, index + 2).map(({ key, label }) => ({ text: label, callback_data: `profile:field:${key}` })));
  }
  rows.push([
    { text: 'Добавить медиа / GIF', callback_data: 'profile:media' },
    { text: 'Форматирование', callback_data: 'profile:font' }
  ]);
  rows.push([
    { text: 'Предпросмотр', callback_data: 'profile:preview' },
    { text: 'Сохранить', callback_data: 'profile:done' }
  ]);
  return { inline_keyboard: rows };
}

function profilePayload(profile) {
  const segments = [
    { text: `👤 ${profile.name || ''}`, key: 'name', prefix: 3 },
    { text: profile.role || '', key: 'role' },
    { text: '' },
    { text: 'О себе' },
    { text: profile.about || '', key: 'about' },
    { text: '' },
    { text: 'Навыки и услуги' },
    { text: profile.skills || '', key: 'skills' },
    ...(profile.contacts ? [{ text: '' }, { text: 'Контакты' }, { text: profile.contacts, key: 'contacts' }] : [])
  ];
  const entities = [];
  let text = '';
  for (const segment of segments) {
    if (text) text += '\n';
    const offset = text.length;
    text += segment.text;
    if (!segment.key) continue;
    const fieldOffset = offset + (segment.prefix || 0);
    for (const entity of profile.entities?.[segment.key] || []) {
      entities.push({ ...entity, offset: entity.offset + fieldOffset });
    }
    const style = profileStyles[profile.styles?.[segment.key]];
    const valueLength = segment.text.length - (segment.prefix || 0);
    if (style && valueLength) entities.push({ type: style, offset: fieldOffset, length: valueLength });
  }
  return { text, entities };
}

function messageMedia(message) {
  for (const [field, type] of [
    ['photo', 'photo'], ['video', 'video'], ['animation', 'animation'], ['document', 'document'],
    ['audio', 'audio'], ['voice', 'voice'], ['video_note', 'video_note'], ['sticker', 'sticker']
  ]) {
    const item = field === 'photo' ? message.photo?.at(-1) : message[field];
    if (item?.file_id) return { type, file_id: item.file_id, caption: message.caption || '', caption_entities: message.caption_entities || [] };
  }
  return null;
}

async function sendProfile(bot, chatId, profile, sendOptions = {}) {
  const mediaItems = Array.isArray(profile.media) ? profile.media : profile.media ? [profile.media] : [];
  for (const media of mediaItems) {
    if (!media.file_id) continue;
    const method = {
      photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation', document: 'sendDocument',
      audio: 'sendAudio', voice: 'sendVoice', video_note: 'sendVideoNote', sticker: 'sendSticker'
    }[media.type];
    if (method) {
      const supportsCaption = !['video_note', 'sticker'].includes(media.type);
      const options = {
        ...(supportsCaption && media.caption ? { caption: media.caption, caption_entities: media.caption_entities } : {}),
        ...sendOptions
      };
      await bot.api[method](chatId, media.file_id, options);
    }
  }
  const payload = profilePayload(profile);
  const resolvedPayload = await resolveCustomEmojiEntities(bot, payload.text, payload.entities);
  if (resolvedPayload.text.trim()) await bot.api.sendMessage(chatId, resolvedPayload.text, {
    ...(resolvedPayload.entities.length ? { entities: resolvedPayload.entities } : {}),
    ...sendOptions
  });
}

const helpText = [
  'КОМАНДЫ ВЛАДЕЛЬЦА',
  '',
  'Бот',
  '*help — эта справка',
  '*вкл  ·  *выкл  ·  *status  ·  *bots  ·  *uptime  ·  *ping  ·  *id  ·  *app',
  '',
  'Анкета',
  '*anketa или *анкета — показать анкету',
  '*анкетад — настроить кнопками',
  '*anketa view — предпросмотр',
  '*anketa send [id|@username] — отправить',
  '*мут <время> — скрыть сообщения собеседника (например, 20м, 2ч, 1д)',
  '*говори или *размут — снять мут',
  '*мут <время> — скрыть сообщения собеседника (например, 20м, 2ч, 1д)',
  '*говори или *размут — снять мут',
  '*cancel — отменить настройку',
  '',
  'Сообщения',
  '*say <id|@username> <текст>',
  '*bizreply <id|@username> <текст>',
  '*spam [id|@username] <1-100> <текст>',
  '',
  'Username доступен после первого сообщения пользователя.'
].join('\n');

function resolveTargetId(target, findUserByUsername = getUserByUsername) {
  if (/^-?\d+$/.test(target)) return target;
  if (!/^@[a-z0-9_]{5,32}$/i.test(target)) return null;
  return findUserByUsername(target)?.telegram_id || null;
}

function unknownTargetMessage(target) {
  return target.startsWith('@')
    ? `Не нашёл ${target}. Username доступен после того, как пользователь напишет боту или в подключённый Business-чат.`
    : 'Укажи числовой Telegram ID или известный боту @username.';
}

async function acceptProfileAnswer(ctx, draft) {
  if (draft.mode === 'media') {
    const media = messageMedia(ctx.message);
    if (!media) {
      await ctx.reply('Пришли фото, видео, GIF, стикер, аудио или файл.');
      return;
    }
    draft.profile.media ||= [];
    if (!Array.isArray(draft.profile.media)) draft.profile.media = [draft.profile.media];
    draft.profile.media.push(media);
  } else {
    const field = profileFields.find(({ key }) => key === draft.field);
    const rawValue = ctx.message.text ?? ctx.message.caption ?? '';
    const value = rawValue.trim();
    if (!field || !value || value.length > field.maxLength) {
      await ctx.reply(`Ответ должен содержать от 1 до ${field.maxLength || 700} символов.`);
      return;
    }
    draft.profile[field.key] = field.key === 'contacts' && value === '-' ? '' : value;
    draft.profile.entities ||= {};
    const leadingTrim = rawValue.length - rawValue.trimStart().length;
    const sourceEntities = ctx.message.text !== undefined
      ? ctx.message.entities || []
      : ctx.message.caption_entities || [];
    draft.profile.entities[field.key] = sourceEntities
      .map((entity) => ({ ...entity, offset: entity.offset - leadingTrim }))
      .filter((entity) => entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= value.length);
  }
  draft.mode = null;
  draft.field = null;
  saveOwnerProfile(draft.profile);
  await ctx.reply('Анкета обновлена.', { reply_markup: profileKeyboard() });
}

async function deleteCommandMessage(bot, ctx) {
  try {
    const businessMessage = ctx.update.business_message;
    if (businessMessage) await bot.api.deleteBusinessMessages(businessMessage.business_connection_id, [businessMessage.message_id]);
    else await bot.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
  } catch {}
}

export function registerAdminCommands(bot, { ownerId, appUrl, sendBusinessReply, startSpamTest, validateBusinessConnection, validateBusinessMute, setBusinessMute, clearBusinessMute, businessReplyState = { enabled: false }, findUserByUsername = getUserByUsername }) {
  const webAppUrl = getValidWebAppUrl(appUrl);
  bot.callbackQuery(/^profile:(.+)$/, async (ctx) => {
    if (String(ctx.from.id) !== String(ownerId)) return ctx.answerCallbackQuery({ text: 'Недостаточно прав', show_alert: true });
    const draft = profileDrafts.get(String(ownerId));
    if (!draft) return ctx.answerCallbackQuery({ text: 'Открой анкету командой *anketa.' });
    const [action, value] = ctx.match[1].split(':');
    const chatId = ctx.callbackQuery.message?.chat.id;
    const sendOptions = draft.businessContext ? { business_connection_id: draft.businessContext.connectionId } : {};
    const reply = (text, options = {}) => bot.api.sendMessage(chatId, text, { ...options, ...sendOptions });
    await ctx.answerCallbackQuery();
    if (action === 'field') {
      const field = profileFields.find(({ key }) => key === value);
      if (!field) return;
      draft.mode = 'field';
      draft.field = field.key;
      return reply(field.prompt);
    }
    if (action === 'media') {
      draft.mode = 'media';
      return reply('Пришли фото, видео, GIF, стикер, аудио или файл. Можно добавить несколько вложений.');
    }
    if (action === 'font') {
      return reply('Выбери стиль:', { reply_markup: { inline_keyboard: [
        [{ text: 'Жирный', callback_data: 'profile:style:bold' }, { text: 'Курсив', callback_data: 'profile:style:italic' }],
        [{ text: 'Подчёркнутый', callback_data: 'profile:style:underline' }, { text: 'Спойлер', callback_data: 'profile:style:spoiler' }],
        [{ text: 'Моноширинный', callback_data: 'profile:style:code' }]
      ] } });
    }
    if (action === 'style') {
      if (!profileStyles[value]) return;
      draft.pendingStyle = value;
      return reply('Для какого раздела применить стиль?', { reply_markup: { inline_keyboard: profileFields.map(({ key, label }) => [{ text: label, callback_data: `profile:fontfield:${key}` }]) } });
    }
    if (action === 'fontfield') {
      if (!profileFields.some(({ key }) => key === value) || !draft.pendingStyle) return;
      draft.profile.styles ||= {};
      draft.profile.styles[value] = draft.pendingStyle;
      draft.pendingStyle = null;
      saveOwnerProfile(draft.profile);
      return reply('Стиль применён.', { reply_markup: profileKeyboard() });
    }
    if (action === 'preview') {
      try {
        return await sendProfile(bot, chatId, draft.profile, sendOptions);
      } catch (error) {
        return reply(`Не удалось показать анкету: ${error.description || error.message}`);
      }
    }
    if (action === 'done') {
      saveOwnerProfile(draft.profile);
      profileDrafts.delete(String(ownerId));
      return reply('Анкета сохранена.');
    }
  });
  bot.on(['message', 'business_message'], async (ctx, next) => {
    const businessMessage = ctx.update.business_message;
    if (businessMessage) {
      ctx = Object.create(ctx);
      Object.defineProperties(ctx, {
        message: { value: businessMessage },
        chat: { value: businessMessage.chat },
        from: { value: businessMessage.from },
        reply: { value: async (text, options) => {
          try {
            return await bot.api.sendMessage(businessMessage.chat.id, text, {
              ...options,
              business_connection_id: businessMessage.business_connection_id
            });
          } catch (error) {
            console.error('Business command reply failed:', error.description || error.message);
            await bot.api.sendMessage(ownerId, `Telegram не отправил ответ от Business-аккаунта: ${error.description || error.message}`);
            return null;
          }
        } }
      });
    }
    let text = ctx.message.text?.trim();
    if (!text) {
      const draft = profileDrafts.get(String(ownerId));
      const draftMatchesContext = draft && String(ctx.from?.id) === String(ownerId) && (draft.businessContext
        ? businessMessage
          && String(ctx.chat.id) === draft.businessContext.chatId
          && businessMessage.business_connection_id === draft.businessContext.connectionId
        : !businessMessage && ctx.chat.type === 'private' && String(ctx.chat.id) === String(ownerId));
      if (draft?.mode && draftMatchesContext) return acceptProfileAnswer(ctx, draft);
      return next();
    }
    const botUsername = bot.botInfo?.username || process.env.BOT_USERNAME || '';
    const mentionPrefix = text.match(/^@([a-z0-9_]+)\s+([\s\S]+)$/i);
    const isOwner = String(ctx.from?.id) === String(ownerId);
    if (mentionPrefix) {
      if (!botUsername || mentionPrefix[1].toLowerCase() !== botUsername.toLowerCase()) return next();
      if (isOwner) text = mentionPrefix[2].trim();
      else return next();
    }
    if (!isOwner && !mentionPrefix) return next();

    if (businessMessage && isOwner) {
      const slashCommand = text.match(/^\/(start|id|app)(?:@([a-z0-9_]+))?(?:\s+[\s\S]*)?$/i);
      if (slashCommand) {
        if (slashCommand[2] && (!botUsername || slashCommand[2].toLowerCase() !== botUsername.toLowerCase())) return next();
        try {
          const connectionError = await validateBusinessConnection?.(businessMessage.business_connection_id);
          if (connectionError) await bot.api.sendMessage(ownerId, connectionError);
          else if (slashCommand[1].toLowerCase() === 'id') {
            await ctx.reply(`Ваш Telegram ID: ${ctx.from.id}${ctx.from.username ? `\nUsername: @${ctx.from.username}` : '\nUsername не задан'}\nID чата: ${ctx.chat.id}`);
          } else if (slashCommand[1].toLowerCase() === 'app') {
            if (!webAppUrl) await ctx.reply('Mini App временно недоступно: требуется публичный HTTPS APP_URL.');
            else await sendWithEmoji((message, options) => ctx.reply(message, options), 'Открой Mini App:', {
              reply_markup: { inline_keyboard: [[{ text: 'Открыть ассистента', url: webAppUrl }]] }
            });
          } else {
            await ctx.reply('Привет! Здесь можно связаться с Wennera, заказать бота или оставить заявку на баг.', webAppUrl
              ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть ассистента', url: webAppUrl }]] } }
              : {});
          }
        } finally {
          await deleteCommandMessage(bot, ctx);
        }
        return;
      }
    }

    const commandMatch = text.match(/^\*([^\s@]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (!commandMatch || (commandMatch[2] && (!botUsername || commandMatch[2].toLowerCase() !== botUsername.toLowerCase()))) {
      const draft = profileDrafts.get(String(ownerId));
      const draftMatchesContext = draft && String(ctx.from.id) === String(ownerId) && (draft.businessContext
        ? businessMessage
          && String(ctx.chat.id) === draft.businessContext.chatId
          && businessMessage.business_connection_id === draft.businessContext.connectionId
        : !businessMessage && ctx.chat.type === 'private' && String(ctx.chat.id) === String(ownerId));
      if (draftMatchesContext) {
        if (businessMessage && validateBusinessConnection) {
          const connectionError = await validateBusinessConnection(businessMessage.business_connection_id);
          if (connectionError) {
            await bot.api.sendMessage(ownerId, connectionError);
            return;
          }
        }
        await acceptProfileAnswer(ctx, draft);
        return;
      }
      return next();
    }
    if (!isOwner) return;
    if (businessMessage && validateBusinessConnection) {
      const connectionError = await validateBusinessConnection(businessMessage.business_connection_id);
      if (connectionError) {
        await bot.api.sendMessage(ownerId, connectionError);
        await deleteCommandMessage(bot, ctx);
        return;
      }
    }
    const currentBusinessTarget = businessMessage ? {
      connectionId: businessMessage.business_connection_id,
      chatId: businessMessage.chat.id
    } : null;
    const businessTargetForChat = (chatId) => currentBusinessTarget && String(chatId) === String(ctx.chat.id)
      ? currentBusinessTarget
      : null;

    const command = commandMatch[1];
    const rest = commandMatch[3] || '';
    let response;
    switch (command.toLowerCase()) {
      case 'help':
        response = helpText;
        break;
      case 'status': {
        response = await getHostStatus();
        try {
          const [identity, webhook] = await Promise.all([bot.api.getMe(), bot.api.getWebhookInfo()]);
          response += `\n\n🤖 Telegram: @${identity.username || identity.id}\nПолучение updates: ${webhook.url ? 'webhook' : 'long polling'}\nВ очереди: ${webhook.pending_update_count || 0}`;
          if (webhook.last_error_message) response += `\nПоследняя ошибка: ${webhook.last_error_message}`;
        } catch (error) {
          response += `\n\n🔴 Telegram API: ${error.description || error.message}`;
        }
        break;
      }
      case 'bots': response = await getHostStatus(); break;
      case 'uptime': response = `⏱ Процесс работает ${formatDuration(process.uptime())}`; break;
      case 'ping': response = `🏓 Pong · ${new Date().toLocaleString('ru-RU')}`; break;
      case 'id': response = `👤 Ваш ID: ${ctx.from.id}${ctx.from.username ? ` (@${ctx.from.username})` : ''}\n💬 ID чата: ${ctx.chat.id}\nТип: ${ctx.chat.type}`; break;
      case 'вкл':
      case 'on':
        businessReplyState.enabled = true;
        response = 'Автоответчик включён.';
        break;
      case 'выкл':
      case 'off':
        businessReplyState.enabled = false;
        response = 'Автоответчик выключен.';
        break;
      case 'мут': {
        const match = rest.trim().match(/^(\d+)\s*([мчд])$/i);
        if (!businessMessage) {
          response = 'Мут работает только в подключённом Business-чате.';
        } else if (!match) {
          response = 'Формат: *мут 20м, *мут 2ч или *мут 1д.';
        } else {
          const amount = Number(match[1]);
          const unit = match[2].toLowerCase();
          const unitMs = { м: 60_000, ч: 3_600_000, д: 86_400_000 }[unit];
          const durationMs = amount * unitMs;
          if (!Number.isSafeInteger(amount) || amount < 1 || durationMs > 365 * 86_400_000) {
            response = 'Укажи срок от 1 минуты до 365 дней.';
          } else {
            const permissionError = await validateBusinessMute?.(businessMessage.business_connection_id);
            if (permissionError) response = permissionError;
            else if (!setBusinessMute) response = 'Команда мута не настроена.';
            else {
              setBusinessMute(ctx.chat.id, businessMessage.business_connection_id, Date.now() + durationMs);
              const unitLabel = { м: 'мин.', ч: 'ч.', д: 'дн.' }[unit];
              response = `Мут включён на ${amount} ${unitLabel}.`;
            }
          }
        }
        break;
      }
      case 'говори':
      case 'размут':
        if (!businessMessage) response = 'Мут работает только в подключённом Business-чате.';
        else if (!clearBusinessMute) response = 'Команда снятия мута не настроена.';
        else {
          clearBusinessMute(ctx.chat.id, businessMessage.business_connection_id);
          response = 'Мут снят. Собеседник снова может писать.';
        }
        break;
      case 'cancel':
        profileDrafts.delete(String(ownerId));
        response = 'Создание анкеты отменено.';
        break;
      case 'anketa':
      case 'анкета':
      case 'анкетад': {
        const [requestedAction, targetChatId] = rest.trim().split(/\s+/);
        const isSetupCommand = command.toLowerCase() === 'анкетад';
        const action = requestedAction || (isSetupCommand ? 'create' : 'view');
        if (action === 'send') {
          const profile = getOwnerProfile();
          if (!profile) response = 'Сначала создай анкету командой *anketa.';
          else {
            try {
              const chatId = targetChatId ? resolveTargetId(targetChatId, findUserByUsername) : ctx.chat.id;
              if (!chatId) {
                response = unknownTargetMessage(targetChatId);
                break;
              }
              const payload = profilePayload(profile);
              const preferredTarget = businessTargetForChat(chatId);
              const businessResponse = targetChatId || preferredTarget
                ? await sendBusinessReply(chatId, payload.text, preferredTarget, payload.entities)
                : null;
              if (businessResponse) response = businessResponse;
              else {
                await sendProfile(bot, chatId, profile);
                response = `Анкета отправлена в чат ${targetChatId || chatId}.`;
              }
            } catch (error) {
              response = `Не удалось отправить анкету: ${error.description || error.message}`;
            }
          }
        } else if (action === 'view') {
          const profile = getOwnerProfile();
          if (profile) {
            await deleteCommandMessage(bot, ctx);
            try {
              return await sendProfile(bot, ctx.chat.id, profile, businessMessage
                ? { business_connection_id: businessMessage.business_connection_id }
                : {});
            } catch (error) {
              return ctx.reply(`Не удалось показать анкету: ${error.description || error.message}`);
            }
          }
          response = 'Анкета ещё не создана. Для настройки используй *анкетад.';
        } else if (['create', 'edit', 'настроить'].includes(action)) {
          profileDrafts.set(String(ownerId), {
            mode: null,
            profile: getOwnerProfile() || {},
            ...(businessMessage ? { businessContext: { chatId: String(ctx.chat.id), connectionId: businessMessage.business_connection_id } } : {})
          });
          await deleteCommandMessage(bot, ctx);
          return ctx.reply('Настрой анкету кнопками ниже.', { reply_markup: profileKeyboard() });
        } else response = 'Использование: *анкета, *анкетад или *anketa send [chat_id].';
        break;
      }
      case 'app':
        if (!webAppUrl) {
          response = 'Mini App недоступно: настрой публичный HTTPS APP_URL.';
          break;
        }
        await deleteCommandMessage(bot, ctx);
        return sendWithEmoji((message, options) => ctx.reply(message, options), 'Открой Mini App:', {
          reply_markup: { inline_keyboard: [[{ text: 'Открыть ассистента', ...(ctx.chat.type === 'private' && !businessMessage ? { web_app: { url: webAppUrl } } : { url: webAppUrl }) }]] }
        });
      case 'spam': {
        const explicitTarget = rest.match(/^(\S+)\s+(\d{1,3})\s+([\s\S]+)$/);
        const currentChatTest = rest.match(/^(\d{1,3})\s+([\s\S]+)$/);
        const targetToken = explicitTarget?.[1];
        const count = Number(explicitTarget?.[2] || currentChatTest?.[1]);
        const message = (explicitTarget?.[3] || currentChatTest?.[2] || '').trim();
        if (!message || !Number.isInteger(count) || count < 1 || count > 100) {
          response = 'Формат: *spam [id|@username] <1-100> <текст>. Без адресата тестирует текущий чат.';
        } else {
          const targetId = targetToken ? resolveTargetId(targetToken, findUserByUsername) : String(ctx.chat.id);
          if (!targetId) response = unknownTargetMessage(targetToken);
          else if (!startSpamTest) response = 'Тестовая отправка не настроена.';
          else {
            const result = startSpamTest(targetId, count, message, businessTargetForChat(targetId));
            if (result.error) response = result.error;
            else {
              response = '';
              void result.promise.catch((error) => console.error('Spam test failed:', error.message));
            }
          }
        }
        break;
      }
      case 'say': {
        const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) response = 'Формат: *say <telegram_id|@username> <текст>';
        else {
          const targetId = resolveTargetId(match[1], findUserByUsername);
          if (!targetId) response = unknownTargetMessage(match[1]);
          else {
            const businessResponse = await sendBusinessReply(targetId, match[2].trim(), businessTargetForChat(targetId));
            if (businessResponse) response = businessResponse;
            else {
              try {
                await sendWithEmoji((message, options) => bot.api.sendMessage(targetId, message, options), match[2].trim());
                response = 'Сообщение отправлено.';
              } catch (error) {
                response = `Не удалось отправить: ${error.description || error.message}. Для обычного бота пользователь должен сначала открыть чат и нажать /start.`;
              }
            }
          }
        }
        break;
      }
      case 'bizreply': {
        const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) response = 'Формат: *bizreply <telegram_id|@username> <текст>';
        else {
          const targetId = resolveTargetId(match[1], findUserByUsername);
          response = targetId
            ? await sendBusinessReply(targetId, match[2].trim(), businessTargetForChat(targetId)) || 'Нет активного Business-диалога с этим ID. Напиши пользователю через подключённый Business-аккаунт, затем повтори команду.'
            : unknownTargetMessage(match[1]);
        }
        break;
      }
      default: response = 'Неизвестная команда. Напишите *help.';
    }
    let sent;
    if (response) sent = await sendWithEmoji((message, options) => ctx.reply(message, options), response);
    await deleteCommandMessage(bot, ctx);
    const commandName = command.toLowerCase();
    const statusDelay = ['мут', 'говори', 'размут'].includes(commandName)
      ? 5000
      : ['вкл', 'выкл', 'on', 'off'].includes(commandName) ? 3000 : 0;
    if (statusDelay && sent?.message_id) {
      setTimeout(() => {
        const businessMessage = ctx.update.business_message;
        const deletion = businessMessage
          ? bot.api.deleteBusinessMessages(businessMessage.business_connection_id, [sent.message_id])
          : bot.api.deleteMessage(ctx.chat.id, sent.message_id);
        deletion.catch(() => {});
      }, statusDelay).unref?.();
    }
  });
}