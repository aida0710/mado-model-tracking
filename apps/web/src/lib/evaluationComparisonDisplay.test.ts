import { describe, expect, it } from 'vitest';
import {
  defaultBaselineAlias,
  formatDelta,
  formatMetricValue,
  formatRelativeDelta,
} from './evaluationComparisonDisplay';

describe('基準aliasの既定値', () => {
  it('productionがあればproductionを選ぶ', () => {
    expect(defaultBaselineAlias({ champion: 'a', production: 'b' })).toBe('production');
  });
  it('productionがなければ名前順で最初のaliasを選び、aliasがなければnullにする', () => {
    expect(defaultBaselineAlias({ staging: 'a', champion: 'b' })).toBe('champion');
    expect(defaultBaselineAlias({})).toBeNull();
  });
});

describe('比較値の表示', () => {
  it('差と相対差は符号を付け、計算できない値は—にする', () => {
    expect(formatDelta(0.1)).toBe('+0.1');
    expect(formatDelta(-0.25)).toBe('-0.25');
    expect(formatDelta(null)).toBe('—');
    expect(formatRelativeDelta(-0.125)).toBe('-12.5%');
    expect(formatRelativeDelta(null)).toBe('—');
  });
  it('数値でない値と欠損を区別して表示する', () => {
    const labels = { notFinite: 'NaN' };
    expect(formatMetricValue(null, 'not_finite', labels)).toBe('NaN');
    expect(formatMetricValue(null, 'missing', labels)).toBe('—');
    expect(formatMetricValue(0.123456789, 'present', labels)).toBe('0.123457');
  });
});
