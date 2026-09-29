import { formatDuration, getHostStatus } from './host-status.js';
import { sendWithEmoji } from './assistant.js';
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

const helpText = [
  '🛠 Команды владельца (только для вашего Telegram ID)',
  '*help - список команд',
  '*status - приложение и доступность хостов',
  '*bots - статусы настроенных ботов',
  '*uptime - время работы процесса',
  '*ping - проверка ответа',
  '*id - ID чата и пользователя',
  '*вкл - включить автоответчик',
  '*выкл - выключить автоответчик',
  '*app - открыть Mini App',
  '*spam [id|@username] <1-100> <текст> - тестовые сообщения в любой чат',
  '*anketa - создать или изменить анкету',
  '*анкета - русскоязычный алиас анкеты',
  '*anketa view - показать анкету',
  '*anketa send [id|@username] - отправить анкету в этот или выбранный чат',
  '*cancel - отменить создание анкеты',
  '*say <id|@username> <текст> - написать пользователю',
  '*bizreply <id|@username> <текст> - ответить в Business-диалог от аккаунта',
  'Username доступен, если пользователь уже писал боту или Business-аккаунту.'
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

function formatProfile(profile) {
  return [
    `👤 ${profile.name}`,
    profile.role,
    '',
    'О себе', profile.about,
    '',
    'Навыки и услуги', profile.skills,
    ...(profile.contacts ? ['', 'Контакты', profile.contacts] : [])
  ].join('\n');
}

async function acceptProfileAnswer(ctx, draft, answer) {
  const field = profileFields[draft.step];
  const value = answer.trim();
  if (!value || value.length > field.maxLength) {
    await ctx.reply(`Ответ должен содержать от 1 до ${field.maxLength} символов.`);
    return;
  }
  draft.profile[field.key] = field.key === 'contacts' && value === '-' ? '' : value;
  draft.step += 1;
  if (draft.step < profileFields.length) {
    await ctx.reply(profileFields[draft.step].prompt);
    return;
  }
  saveOwnerProfile(draft.profile);
  profileDrafts.delete(String(ctx.from.id));
  await sendWithEmoji((text, options) => ctx.reply(text, options), `Анкета сохранена.\n\n${formatProfile(draft.profile)}`);
}

export function registerAdminCommands(bot, { ownerId, appUrl, sendBusinessReply, startSpamTest, validateBusinessConnection, businessReplyState = { enabled: true }, findUserByUsername = getUserByUsername }) {
  const webAppUrl = getValidWebAppUrl(appUrl);
  bot.on(['message:text', 'business_message'], async (ctx, next) => {
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
    if (!text) return next();
    const botUsername = bot.botInfo?.username || process.env.BOT_USERNAME || '';
    const mentionPrefix = text.match(/^@([a-z0-9_]+)\s+([\s\S]+)$/i);
    if (mentionPrefix) {
      if (!botUsername || mentionPrefix[1].toLowerCase() !== botUsername.toLowerCase()) return next();
      text = mentionPrefix[2].trim();
    }

    if (businessMessage && String(ctx.from?.id) === String(ownerId)) {
      const slashCommand = text.match(/^\/(start|id|app)(?:@([a-z0-9_]+))?(?:\s+[\s\S]*)?$/i);
      if (slashCommand) {
        if (slashCommand[2] && (!botUsername || slashCommand[2].toLowerCase() !== botUsername.toLowerCase())) return next();
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
        await acceptProfileAnswer(ctx, draft, text);
        return;
      }
      return next();
    }
    if (String(ctx.from.id) !== String(ownerId)) return;
    if (businessMessage && validateBusinessConnection) {
      const connectionError = await validateBusinessConnection(businessMessage.business_connection_id);
      if (connectionError) {
        await bot.api.sendMessage(ownerId, connectionError);
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
        if (ctx.chat.type === 'private') response = helpText;
        else {
          try {
            await sendWithEmoji((message, options) => bot.api.sendMessage(ownerId, message, options), helpText);
            response = 'Список команд отправил в личный чат.';
          } catch {
            response = 'Не смог отправить команды в личку. Сначала открой бота в личном чате.';
          }
        }
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
      case 'cancel':
        profileDrafts.delete(String(ownerId));
        response = 'Создание анкеты отменено.';
        break;
      case 'anketa':
      case 'анкета': {
        const [action = 'create', targetChatId] = rest.split(/\s+/);
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
              const preferredTarget = businessTargetForChat(chatId);
              const businessResponse = targetChatId || preferredTarget
                ? await sendBusinessReply(chatId, formatProfile(profile), preferredTarget)
                : null;
              if (businessResponse) response = businessResponse;
              else {
                await sendWithEmoji((message, options) => bot.api.sendMessage(chatId, message, options), formatProfile(profile));
                response = `Анкета отправлена в чат ${targetChatId || chatId}.`;
              }
            } catch (error) {
              response = `Не удалось отправить анкету: ${error.description || error.message}`;
            }
          }
        } else if (action === 'view') {
          if (ctx.chat.type !== 'private') response = 'Просмотр анкеты доступен только в личном чате с ботом.';
          else {
            const profile = getOwnerProfile();
            response = profile ? formatProfile(profile) : 'Анкета ещё не создана. Напиши *anketa.';
          }
        } else if (action === 'create') {
          if (ctx.chat.type !== 'private') response = 'Создавай анкету в личном чате с ботом командой *anketa.';
          else {
            profileDrafts.set(String(ownerId), {
              step: 0,
              profile: {},
              ...(businessMessage ? { businessContext: { chatId: String(ctx.chat.id), connectionId: businessMessage.business_connection_id } } : {})
            });
            return ctx.reply(`Создаём анкету. На каждом шаге отправь ответ отдельным сообщением.\n\n${profileFields[0].prompt}`);
          }
        } else response = 'Использование: *anketa, *anketa view или *anketa send [chat_id].';
        break;
      }
      case 'app':
        if (!webAppUrl) {
          response = 'Mini App недоступно: настрой публичный HTTPS APP_URL.';
          break;
        }
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
              response = `Тест запущен: ${count} сообщений, интервал 1 сек.`;
              const notifyOwner = businessMessage
                ? (summary) => sendWithEmoji((replyText, options) => ctx.reply(replyText, options), summary)
                : (summary) => bot.api.sendMessage(ownerId, summary);
              void result.promise.then(notifyOwner)
                .catch((error) => console.error('Spam test result notification failed:', error.message));
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
    if (response) await sendWithEmoji((message, options) => ctx.reply(message, options), response);
  });
}