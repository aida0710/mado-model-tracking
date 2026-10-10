import { describe, expect, it } from 'vitest';
import { clampNavigationWidth, NAVIGATION_WIDTH, storedNavigationWidth } from './navigationWidth';

describe('navigation sidebar width', () => {
  it('ドラッグした幅を最小と最大の間に収め、整数にする', () => {
    expect(clampNavigationWidth(10)).toBe(NAVIGATION_WIDTH.min);
    expect(clampNavigationWidth(10_000)).toBe(NAVIGATION_WIDTH.max);
    expect(clampNavigationWidth(200.6)).toBe(201);
  });

  it('保存された値が無いか壊れていれば既定の幅にし、範囲外なら範囲に収める', () => {
    expect(storedNavigationWidth(null)).toBe(NAVIGATION_WIDTH.default);
    expect(storedNavigationWidth('wide')).toBe(NAVIGATION_WIDTH.default);
    expect(storedNavigationWidth('240')).toBe(240);
    expect(storedNavigationWidth('9999')).toBe(NAVIGATION_WIDTH.max);
  });
});
