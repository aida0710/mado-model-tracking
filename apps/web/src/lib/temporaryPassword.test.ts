import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword, isLongEnoughPassword } from './temporaryPassword';

describe('初回パスワード', () => {
  it('生成したパスワードは24文字のbase64urlで、毎回異なる', () => {
    const first = generateTemporaryPassword();
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(generateTemporaryPassword()).not.toBe(first);
    expect(isLongEnoughPassword(first)).toBe(true);
  });

  it('長さはUTF-8のbyteで数え、日本語4文字（12 byte）は条件を満たす', () => {
    expect(isLongEnoughPassword('short-11-ch')).toBe(false);
    expect(isLongEnoughPassword('パスワード'.slice(0, 4))).toBe(true);
  });
});
