import { formatDuration, getHostStatus } from './host-status.js';
import { sendWithEmoji } from './assistant.js';
import { getOwnerProfile, saveOwnerProfile } from './db.js';

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
  '*app - открыть Mini App',
  '*anketa - создать или изменить анкету',
  '*анкета - русскоязычный алиас анкеты',
  '*anketa view - показать анкету в личке',
  '*anketa send [chat_id] - отправить анкету в этот или выбранный чат',
  '*cancel - отменить создание анкеты',
  '*say <id> <текст> - написать пользователю',
  '*bizreply <id> <текст> - ответить в Business-диалог от аккаунта'
].join('\n');

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

export function registerAdminCommands(bot, { ownerId, appUrl, sendBusinessReply }) {
  bot.on('message:text', async (ctx, next) => {
    let text = ctx.message.text.trim();
    const botUsername = bot.botInfo?.username || process.env.BOT_USERNAME || '';
    const mentionPrefix = text.match(/^@([a-z0-9_]+)\s+([\s\S]+)$/i);
    if (mentionPrefix) {
      if (!botUsername || mentionPrefix[1].toLowerCase() !== botUsername.toLowerCase()) return next();
      text = mentionPrefix[2].trim();
    }

    const commandMatch = text.match(/^\*([^\s@]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (!commandMatch || (commandMatch[2] && (!botUsername || commandMatch[2].toLowerCase() !== botUsername.toLowerCase()))) {
      const draft = profileDrafts.get(String(ownerId));
      if (draft && ctx.chat.type === 'private' && String(ctx.chat.id) === String(ownerId)) {
        await acceptProfileAnswer(ctx, draft, text);
        return;
      }
      return next();
    }
    if (String(ctx.from.id) !== String(ownerId)) return;

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
      case 'id': response = `👤 Ваш ID: ${ctx.from.id}\n💬 ID чата: ${ctx.chat.id}\nТип: ${ctx.chat.type}`; break;
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
              const chatId = targetChatId || ctx.chat.id;
              await sendWithEmoji((message, options) => bot.api.sendMessage(chatId, message, options), formatProfile(profile));
              response = `Анкета отправлена в чат ${chatId}.`;
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
            profileDrafts.set(String(ownerId), { step: 0, profile: {} });
            return ctx.reply(`Создаём анкету. На каждом шаге отправь ответ отдельным сообщением.\n\n${profileFields[0].prompt}`);
          }
        } else response = 'Использование: *anketa, *anketa view или *anketa send [chat_id].';
        break;
      }
      case 'app':
        return sendWithEmoji((message, options) => ctx.reply(message, options), 'Открой Mini App:', {
          reply_markup: { inline_keyboard: [[{ text: 'Открыть ассистента', ...(ctx.chat.type === 'private' ? { web_app: { url: appUrl } } : { url: appUrl }) }]] }
        });
      case 'say': {
        const match = rest.match(/^(\d+)\s+([\s\S]+)$/);
        if (!match) response = 'Формат: *say <telegram_id> <текст>';
        else {
          try {
            await sendWithEmoji((message, options) => bot.api.sendMessage(match[1], message, options), match[2].trim());
            response = 'Сообщение отправлено.';
          } catch (error) {
            response = `Не удалось отправить: ${error.description || error.message}`;
          }
        }
        break;
      }
      case 'bizreply': {
        const match = rest.match(/^(\d+)\s+([\s\S]+)$/);
        if (!match) response = 'Формат: *bizreply <telegram_id> <текст>';
        else response = await sendBusinessReply(match[1], match[2].trim());
        break;
      }
      default: response = 'Неизвестная команда. Напишите *help.';
    }
    if (response) await sendWithEmoji((message, options) => ctx.reply(message, options), response);
  });
}