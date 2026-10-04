import type { TFunction } from '../../i18n/i18n';

/** Human-readable description for common 5-field cron expressions; falls back to the raw text. */
export function describeCron(expr: string, t: TFunction): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const time =
    /^\d+$/.test(min) && /^\d+$/.test(hour)
      ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
      : null;
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return t('cron.hourly', { min });
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return t('cron.everyMinutes', { n: min.slice(2) });
  if (time && dom === '*' && mon === '*' && dow === '*') return t('cron.daily', { time });
  if (time && dom === '*' && mon === '*' && dow === '1-5') return t('cron.weekdays', { time });
  if (time && dom === '*' && mon === '*' && /^[0-6]$/.test(dow))
    return t('cron.weekly', { time, day: t(`cron.days.${dow}` as Parameters<TFunction>[0]) });
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*')
    return t('cron.monthly', { time, day: dom });
  return expr;
}
