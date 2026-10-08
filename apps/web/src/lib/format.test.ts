import { describe, expect, it } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
  it('KiB以上は小数1桁にそろえる', () => {
    expect(formatBytes(25.043 * 1024)).toBe('25.0 KiB');
    expect(formatBytes(2.06055 * 1024)).toBe('2.1 KiB');
    expect(formatBytes(75.3311 * 1024)).toBe('75.3 KiB');
    expect(formatBytes(6.14697 * 1024 ** 2)).toBe('6.1 MiB');
    expect(formatBytes(38.147 * 1024 ** 2)).toBe('38.1 MiB');
  });

  it('1024未満はbyteの整数、0は0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('丸めると1024になる値は次の単位で表す', () => {
    expect(formatBytes(1024 * 1024 - 10)).toBe('1.0 MiB');
    expect(formatBytes(1024)).toBe('1.0 KiB');
  });
});
