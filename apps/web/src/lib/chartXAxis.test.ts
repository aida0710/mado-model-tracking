import { describe, expect, it } from 'vitest';
import { formatElapsedSeconds, formatWallTime, formatXTick, formatXValue } from './chartXAxis';

describe('x軸の目盛り', () => {
  it('stepは整数で表示し、桁が多いときは短縮する', () => {
    expect(formatXTick({ kind: 'step' }, 1234.4)).toBe('1234');
    expect(formatXTick({ kind: 'step' }, 1_250_000)).toBe('1.25M');
    expect(formatXValue({ kind: 'step' }, 1_250_000)).toBe('1250000');
  });

  it('経過時間は大きい方から2つの単位で表示する', () => {
    expect(formatElapsedSeconds(45.4)).toBe('45s');
    expect(formatElapsedSeconds(245)).toBe('4m05s');
    expect(formatElapsedSeconds(4980)).toBe('1h23m');
    expect(formatElapsedSeconds(2 * 86400 + 3 * 3600 + 59)).toBe('2d03h');
    expect(formatXTick({ kind: 'relative_time' }, 4980)).toBe('1h23m');
  });

  it('時刻はローカル時刻で、目盛りは月日と分まで、tooltipは秒まで出す', () => {
    const epochMilliseconds = new Date(2026, 9, 8, 13, 45, 7).getTime();
    expect(formatWallTime(epochMilliseconds, false)).toBe('10/08 13:45');
    expect(formatXValue({ kind: 'wall_time' }, epochMilliseconds)).toBe('2026/10/08 13:45:07');
  });

  it('メトリクスのx軸は数値として表示する', () => {
    expect(formatXTick({ kind: 'metric', metricKey: 'epoch' }, 1.5)).toBe('1.5');
  });
});
