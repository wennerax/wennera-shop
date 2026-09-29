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

export async function sendWithEmoji(send, text, options = {}) {
  const payload = addPremiumEmoji(text);
  const formattedOptions = { ...options, ...(payload.entities ? { entities: payload.entities } : {}) };
  try {
    return await send(payload.text, formattedOptions);
  } catch (error) {
    if (!payload.entities || !/emoji|entit|premium/i.test(error.description || error.message)) throw error;
    return send(`${process.env.PREMIUM_EMOJI_ALT || '✨'} ${text}`, options);
  }
}