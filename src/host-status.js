function getTargets() {
  if (!process.env.BOT_HEALTHCHECKS) return [];
  try {
    const targets = JSON.parse(process.env.BOT_HEALTHCHECKS);
    return Array.isArray(targets) ? targets.filter((target) => target?.name && target?.url) : [];
  } catch (error) {
    console.error('BOT_HEALTHCHECKS must be a JSON array:', error.message);
    return [];
  }
}

export async function getHostStatus() {
  const memory = process.memoryUsage();
  const lines = [
    '🖥 Приложение: работает',
    `⏱ Аптайм: ${formatDuration(process.uptime())}`,
    `💾 Память: ${Math.round(memory.rss / 1024 / 1024)} МБ RSS`
  ];
  const targets = getTargets();

  if (targets.length) {
    const statuses = await Promise.all(targets.map(async ({ name, url }) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        return `${response.ok ? '🟢' : '🔴'} ${name}: HTTP ${response.status}`;
      } catch {
        return `🔴 ${name}: нет ответа`;
      }
    }));
    lines.push('', ...statuses);
  } else {
    lines.push('', 'Внешние боты: health URL не настроены');
  }
  return lines.join('\n');
}

export function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [days && `${days}д`, hours && `${hours}ч`, minutes && `${minutes}м`, `${remainder}с`].filter(Boolean).join(' ');
}