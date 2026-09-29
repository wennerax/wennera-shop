export function getValidWebAppUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isIncomingBusinessMessage(message, ownerId) {
  return Boolean(
    message?.business_connection_id
    && message.chat?.type === 'private'
    && message.from
    && !message.from.is_bot
    && !message.sender_business_bot
    && String(message.from.id) !== String(ownerId)
    && Number.isFinite(message.date)
    && Date.now() / 1000 - message.date < 86400
  );
}
