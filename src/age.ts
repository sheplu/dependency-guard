const MS_PER_DAY = 86_400_000;

export function ageInDays(publishedAt: string | null, now: Date = new Date()): number | null {
  if (!publishedAt) return null;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return null;
  const diff = now.getTime() - t;
  if (diff < 0) return 0;
  return Math.floor(diff / MS_PER_DAY);
}

export function formatAge(days: number | null): string {
  if (days === null) return '-';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
