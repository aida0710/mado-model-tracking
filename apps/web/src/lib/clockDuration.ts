import { text } from '../i18n/catalog';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
// Hours may exceed a day (72:00:00), as schedulers write a time limit.
const CLOCK_DURATION_PATTERN = /^(\d+):([0-5]\d):([0-5]\d)$/;
const TWO_DIGITS = 2;

/**
 * Seconds of a duration written as HH:MM:SS (PBS walltime, Slurm --time); an empty value is null.
 * Anything else is refused rather than guessed, because the job shell passes it to the scheduler.
 */
export function parseClockDuration(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = CLOCK_DURATION_PATTERN.exec(trimmed);
  if (!match) throw new Error(text.clockDurationError);
  const [hours, minutes, seconds] = match.slice(1).map(Number) as [number, number, number];
  return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds;
}

/** The HH:MM:SS form of a duration in seconds; null is the empty string. */
export function formatClockDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const pad = (value: number) => String(value).padStart(TWO_DIGITS, '0');
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds % SECONDS_PER_MINUTE)}`;
}
