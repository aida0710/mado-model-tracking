import { describe, expect, it } from 'vitest';
import { formatChartTick, formatTickNumber } from './chartTicks';

describe('図の値の軸の目盛り', () => {
  it('ふつうの大きさの値は4桁までの数字で出す', () => {
    expect(formatTickNumber(0)).toBe('0');
    expect(formatTickNumber(0.0575)).toBe('0.0575');
    expect(formatTickNumber(1.05)).toBe('1.05');
    expect(formatTickNumber(12345)).toBe('12350');
    expect(formatTickNumber(-4)).toBe('-4');
  });

  it('対数軸の小さな値や大きな値は桁を並べず指数で出す', () => {
    expect(formatTickNumber(0.000000000000001)).toBe('1e-15');
    expect(formatTickNumber(0.00025)).toBe('2.5e-4');
    expect(formatTickNumber(24503275520)).toBe('2.45e+10');
  });

  it('bytesの図は2進の単位で、bytes/秒の図は/sを付けて出す', () => {
    expect(formatChartTick(24503275520, 'bytes')).toBe('22.8\u00a0GiB');
    expect(formatChartTick(0, 'bytes')).toBe('0\u00a0B');
    expect(formatChartTick(1536, 'bytes_per_second')).toBe('1.5\u00a0KiB/s');
    // 改行しない空白なので、目盛りが数字と単位の2行に折れない。
    expect(formatChartTick(1199571, 'bytes_per_second')).toBe('1.14\u00a0MiB/s');
    expect(formatChartTick(0.5, 'number')).toBe('0.5');
  });
});
