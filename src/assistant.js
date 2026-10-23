const defaultInstructions = 'Ты цифровой ассистент Wennera. Отвечай по-русски, кратко и по делу. Не выдавай себя за человека и не обещай действий от имени владельца; для личных решений предложи оставить сообщение через Mini App.';

export async function generateAssistantReply(text) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: process.env.AI_SYSTEM_PROMPT || defaultInstructions },
        { role: 'user', content: text.slice(0, 6000) }
      ],
      max_tokens: 500,
      temperature: 0.5
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

export function addPremiumEmoji(text) {
  const customEmojiId = process.env.PREMIUM_EMOJI_ID;
  if (!customEmojiId) return { text };

  const fallback = process.env.PREMIUM_EMOJI_ALT || '✨';
  return {
    text: `${fallback} ${text}`,
    entities: [{ type: 'custom_emoji', offset: 0, length: fallback.length, custom_emoji_id: customEmojiId }]
  };
}

export async function resolveCustomEmojiEntities(bot, text, entities = []) {
  const customEntities = entities.filter((entity) => entity.type === 'custom_emoji' && entity.custom_emoji_id);
  if (!customEntities.length) return { text, entities };

  const ids = [...new Set(customEntities.map((entity) => entity.custom_emoji_id))];
  let stickers;
  try {
    stickers = await bot.api.getCustomEmojiStickers(ids);
  } catch {
    return { text, entities };
  }
  const stickersById = new Map(stickers.map((sticker) => [sticker.custom_emoji_id, sticker]));
  const replacements = customEntities
    .map((entity) => ({
      offset: entity.offset,
      length: entity.length,
      emoji: stickersById.get(entity.custom_emoji_id)?.emoji
    }))
    .filter(({ offset, length, emoji }) => emoji && offset >= 0 && length > 0 && offset + length <= text.length)
    .sort((left, right) => left.offset - right.offset);

  if (!replacements.length) return { text, entities };

  let resolvedText = '';
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.offset < cursor) continue;
    resolvedText += text.slice(cursor, replacement.offset) + replacement.emoji;
    cursor = replacement.offset + replacement.length;
  }
  resolvedText += text.slice(cursor);

  const mapOffset = (position, isEnd) => {
    let delta = 0;
    for (const replacement of replacements) {
      const end = replacement.offset + replacement.length;
      if (position >= end) {
        delta += replacement.emoji.length - replacement.length;
      } else if (position > replacement.offset || (isEnd && position === replacement.offset)) {
        return replacement.offset + delta + (isEnd ? replacement.emoji.length : 0);
      } else {
        break;
      }
    }
    return position + delta;
  };

  const resolvedEntities = entities.map((entity) => {
    const offset = mapOffset(entity.offset, false);
    const end = mapOffset(entity.offset + entity.length, true);
    return { ...entity, offset, length: end - offset };
  });

  return { text: resolvedText, entities: resolvedEntities };
}

export async function sendWithEmoji(send, text, options = {}) {
  const payload = addPremiumEmoji(text);
  const sourceEntities = options.entities || [];
  const prefixLength = payload.text.length - text.length;
  const entities = [
    ...sourceEntities.map((entity) => ({ ...entity, offset: entity.offset + prefixLength })),
    ...(payload.entities || [])
  ].sort((left, right) => left.offset - right.offset);
  const formattedOptions = { ...options, ...(entities.length ? { entities } : {}) };
  try {
    return await send(payload.text, formattedOptions);
  } catch (error) {
    if (!payload.entities || !/emoji|entit|premium/i.test(error.description || error.message)) throw error;
    const fallbackText = `${process.env.PREMIUM_EMOJI_ALT || '✨'} ${text}`;
    const fallbackEntities = sourceEntities
      .map((entity) => ({ ...entity, offset: entity.offset + fallbackText.length - text.length }));
    const fallbackOptions = { ...options };
    if (sourceEntities.length) {
      if (fallbackEntities.length) fallbackOptions.entities = fallbackEntities;
      else delete fallbackOptions.entities;
    }
    return send(fallbackText, fallbackOptions);
  }
}