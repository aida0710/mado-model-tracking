import { describe, expect, it } from 'vitest';
import { isListNavigationKey, moveActiveIndex } from './listNavigation';

describe('moveActiveIndex', () => {
  it('↓は次へ、最後の次は先頭へ戻る', () => {
    expect(moveActiveIndex({ current: 0, key: 'ArrowDown', count: 3 })).toBe(1);
    expect(moveActiveIndex({ current: 2, key: 'ArrowDown', count: 3 })).toBe(0);
  });

  it('↑は前へ、先頭の前は最後へ回る', () => {
    expect(moveActiveIndex({ current: 2, key: 'ArrowUp', count: 3 })).toBe(1);
    expect(moveActiveIndex({ current: 0, key: 'ArrowUp', count: 3 })).toBe(2);
  });

  it('何も選んでいないとき、↓は先頭、↑は最後を選ぶ', () => {
    expect(moveActiveIndex({ current: -1, key: 'ArrowDown', count: 3 })).toBe(0);
    expect(moveActiveIndex({ current: -1, key: 'ArrowUp', count: 3 })).toBe(2);
  });

  it('Home は先頭、End は最後を選ぶ', () => {
    expect(moveActiveIndex({ current: 1, key: 'Home', count: 4 })).toBe(0);
    expect(moveActiveIndex({ current: 1, key: 'End', count: 4 })).toBe(3);
  });

  it('項目が無ければ何も選ばない', () => {
    expect(moveActiveIndex({ current: -1, key: 'ArrowDown', count: 0 })).toBe(-1);
    expect(moveActiveIndex({ current: 0, key: 'End', count: 0 })).toBe(-1);
  });
});

describe('isListNavigationKey', () => {
  it('矢印・Home・End だけを一覧の移動キーとみなし、Enter や文字は入力に任せる', () => {
    expect(['ArrowDown', 'ArrowUp', 'Home', 'End'].every(isListNavigationKey)).toBe(true);
    expect(isListNavigationKey('Enter')).toBe(false);
    expect(isListNavigationKey('a')).toBe(false);
  });
});
