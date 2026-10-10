import { describe, expect, it } from 'vitest';
import { formatSiteVariables, parseSiteVariables } from './siteVariables';

describe('siteの変数（NAME=VALUE）', () => {
  it('1行に1つ読み、空行と名前・値の前後の空白を除き、値の中の=は残す', () => {
    expect(parseSiteVariables('GROUP=gaa50000\n\n  QUEUE = gpu  \nOPTIONS=-l select=1\n')).toEqual({
      GROUP: 'gaa50000',
      QUEUE: 'gpu',
      OPTIONS: '-l select=1',
    });
    expect(parseSiteVariables('')).toEqual({});
  });

  it('=の無い行、シェル変数にならない名前、同じ名前の2回目を拒否する', () => {
    expect(() => parseSiteVariables('GROUP')).toThrow('GROUP');
    expect(() => parseSiteVariables('1GROUP=x')).toThrow('1GROUP=x');
    expect(() => parseSiteVariables('MY-GROUP=x')).toThrow('MY-GROUP=x');
    expect(() => parseSiteVariables('=x')).toThrow();
    expect(() => parseSiteVariables('GROUP=a\nGROUP=b')).toThrow('GROUP');
  });

  it('65個以上の変数を拒否する', () => {
    const lines = Array.from({ length: 65 }, (_, index) => `V${index}=x`).join('\n');
    expect(() => parseSiteVariables(lines)).toThrow('64個');
  });

  it('__proto__という名前もふつうの変数として残す', () => {
    const variables = parseSiteVariables('__proto__=x');
    expect(Object.keys(variables)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(variables)).toBe(Object.prototype);
  });

  it('保存した変数を同じ行に戻す', () => {
    const variables = { GROUP: 'gaa50000', OPTIONS: '-l select=1' };
    expect(formatSiteVariables(variables)).toBe('GROUP=gaa50000\nOPTIONS=-l select=1');
    expect(parseSiteVariables(formatSiteVariables(variables))).toEqual(variables);
  });
});
