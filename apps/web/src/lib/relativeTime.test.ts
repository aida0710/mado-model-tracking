import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

describe('相対時刻', () => {
  it('1分未満と未来の時刻は「今」にする', () => {
    expect(formatRelativeTime('2026-10-08T11:59:30.000Z', NOW)).toBe('今');
    expect(formatRelativeTime('2026-10-08T12:00:05.000Z', NOW)).toBe('今');
  });

  it('経過時間に合う最も大きい単位で表す', () => {
    expect(formatRelativeTime('2026-10-08T11:55:00.000Z', NOW)).toBe('5 分前');
    expect(formatRelativeTime('2026-10-08T09:00:00.000Z', NOW)).toBe('3 時間前');
    expect(formatRelativeTime('2026-10-07T11:00:00.000Z', NOW)).toBe('昨日');
    expect(formatRelativeTime('2026-09-20T12:00:00.000Z', NOW)).toBe('2 週間前');
  });
});
