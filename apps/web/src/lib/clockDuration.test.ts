import { describe, expect, it } from 'vitest';
import { formatClockDuration, parseClockDuration } from './clockDuration';

describe('HH:MM:SSの時間', () => {
  it('スケジューラの書き方を秒に直し、空は未指定にする', () => {
    expect(parseClockDuration('12:00:00')).toBe(12 * 60 * 60);
    expect(parseClockDuration(' 0:05:30 ')).toBe(5 * 60 + 30);
    // 1日を超える時間もHHのまま書く（PBSのwalltime=72:00:00）
    expect(parseClockDuration('72:00:00')).toBe(72 * 60 * 60);
    expect(parseClockDuration('')).toBeNull();
  });

  it.each(['12:00', '1h', '3600', '1:60:00', '1:00:60', '-1:00:00', '1:2:3'])(
    '形の違う %s は推測せずに拒否する',
    (value) => expect(() => parseClockDuration(value)).toThrow('HH:MM:SS'),
  );

  it('秒をHH:MM:SSで表し、未指定は空にする', () => {
    expect(formatClockDuration(12 * 60 * 60)).toBe('12:00:00');
    expect(formatClockDuration(90061)).toBe('25:01:01');
    expect(formatClockDuration(null)).toBe('');
    expect(parseClockDuration(formatClockDuration(4000))).toBe(4000);
  });
});
