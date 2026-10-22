import fs from 'node:fs/promises';
import path from 'node:path';

const mediaLabels = [
  ['live_photo', 'Live Photo'],
  ['photo', 'Фото'],
  ['video', 'Видео'],
  ['animation', 'GIF'],
  ['audio', 'Аудио'],
  ['voice', 'Голосовое сообщение'],
  ['video_note', 'Видеосообщение'],
  ['document', 'Файл'],
  ['sticker', 'Стикер'],
  ['paid_media', 'Платное медиа'],
  ['contact', 'Контакт'],
  ['location', 'Геопозиция'],
  ['venue', 'Место'],
  ['poll', 'Опрос'],
  ['dice', 'Dice'],
  ['game', 'Игра'],
  ['story', 'История'],
  ['checklist', 'Чек-лист']
];

export function describeMessageMedia(message) {
  const [field, label] = mediaLabels.find(([key]) => message[key]) || [];
  if (!field) return 'Вложение';
  if (field === 'document') return message.document.file_name || label;
  if (field === 'audio') return message.audio.title || label;
  return label;
}

function getDownloadableMedia(message) {
  const files = [];
  const add = (field, file) => {
    if (file?.file_id) files.push({ field, file });
  };

  add('photo', message.photo?.at(-1));
  for (const field of ['video', 'animation', 'audio', 'voice', 'video_note', 'document', 'sticker']) {
    add(field, message[field]);
  }
  if (message.live_photo?.file_id) {
    add('live-photo', message.live_photo.photo?.at(-1));
    add('live-photo', message.live_photo);
  }
  for (const media of message.paid_media || []) {
    add('paid-photo', media.photo?.at(-1));
    add('paid-video', media.video);
  }

  return [...new Map(files.map(({ field, file }) => [file.file_id, { field, file }])).values()];
}

export async function saveMessageMedia(bot, message) {
  const files = getDownloadableMedia(message);
  if (!files.length) return [];

  const archiveDir = path.resolve('uploads', 'telegram-media');
  await fs.mkdir(archiveDir, { recursive: true });
  const saved = [];

  for (const [index, { field, file }] of files.entries()) {
    const telegramUrl = await bot.api.getFileLink(file.file_id);
    const response = await fetch(telegramUrl);
    if (!response.ok) throw new Error(`Telegram media download failed: HTTP ${response.status}`);

    const telegramPath = path.basename(new URL(telegramUrl).pathname);
    const extension = path.extname(telegramPath);
    const safeExtension = /^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension : '.bin';
    const filename = `chat-${message.chat.id}_message-${message.message_id}_${field}-${index + 1}${safeExtension}`;
    const destination = path.join(archiveDir, filename);
    await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
    saved.push(destination);
  }

  return saved;
}

export async function copyBusinessMediaToChat(bot, chatId, message) {
  try {
    return await bot.api.copyMessage(chatId, message.chat.id, message.message_id);
  } catch (error) {
    console.warn(`Telegram could not copy ${describeMessageMedia(message)} as a whole; trying a media-specific fallback:`, error.description || error.message);
  }
  if (message.live_photo?.file_id) {
    const photo = message.live_photo.photo?.at(-1);
    if (photo) await bot.api.sendPhoto(chatId, photo.file_id);
    return bot.api.sendVideo(chatId, message.live_photo.file_id);
  }
  if (message.photo?.length) {
    return bot.api.sendPhoto(chatId, message.photo.at(-1).file_id, captionOptions(message));
  }
  for (const [field, method] of [
    ['video', 'sendVideo'], ['animation', 'sendAnimation'], ['audio', 'sendAudio'],
    ['voice', 'sendVoice'], ['video_note', 'sendVideoNote'], ['document', 'sendDocument'],
    ['sticker', 'sendSticker']
  ]) {
    if (message[field]?.file_id) return bot.api[method](chatId, message[field].file_id, captionOptions(message));
  }
  if (message.contact) {
    const { phone_number, first_name, last_name, vcard } = message.contact;
    return bot.api.sendContact(chatId, phone_number, first_name, { last_name, vcard });
  }
  if (message.location) {
    const { latitude, longitude } = message.location;
    return bot.api.sendLocation(chatId, latitude, longitude);
  }
  if (message.venue) {
    const { latitude, longitude } = message.venue.location;
    return bot.api.sendVenue(chatId, latitude, longitude, message.venue.title, message.venue.address);
  }
  if (message.dice) return bot.api.sendDice(chatId, { emoji: message.dice.emoji });
  if (message.poll) {
    const { question, options, is_anonymous, type, allows_multiple_answers, correct_option_ids, explanation } = message.poll;
    return bot.api.sendPoll(chatId, question, options.map(({ text }) => ({ text })), {
      is_anonymous, type, allows_multiple_answers, correct_option_ids, explanation
    });
  }
  return null;
}

function captionOptions(message) {
  return message.caption ? { caption: message.caption, caption_entities: message.caption_entities } : {};
}