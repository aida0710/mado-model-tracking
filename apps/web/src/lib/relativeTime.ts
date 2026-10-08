// Steps for "3分前" style labels: each unit is used until the next one fits.
const RELATIVE_TIME_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: 'year', seconds: 365 * 24 * 60 * 60 },
  { unit: 'month', seconds: 30 * 24 * 60 * 60 },
  { unit: 'week', seconds: 7 * 24 * 60 * 60 },
  { unit: 'day', seconds: 24 * 60 * 60 },
  { unit: 'hour', seconds: 60 * 60 },
  { unit: 'minute', seconds: 60 },
];
const relativeTimeFormat = new Intl.RelativeTimeFormat('ja-JP', { numeric: 'auto' });

/** "たった今", "5分前", "昨日" ... measured from now. Clocks slightly ahead read as now. */
export function formatRelativeTime(value: string, now: number = Date.now()): string {
  const elapsedSeconds = Math.max(0, (now - Date.parse(value)) / 1000);
  for (const { unit, seconds } of RELATIVE_TIME_UNITS) {
    if (elapsedSeconds >= seconds)
      return relativeTimeFormat.format(-Math.floor(elapsedSeconds / seconds), unit);
  }
  return relativeTimeFormat.format(0, 'second');
}
