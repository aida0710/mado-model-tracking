import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberAuthReturnPath, takeAuthReturnPath } from './authReturnPath';

afterEach(() => vi.unstubAllGlobals());
describe('SSO後のURL復帰', () => {
  it('プロジェクトとRunのURLを一度だけ復帰用に取り出す', () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      setItem: (key: string, value: string) => entries.set(key, value),
      getItem: (key: string) => entries.get(key) ?? null,
      removeItem: (key: string) => entries.delete(key),
    });
    rememberAuthReturnPath('/projects/project/runs/run?tab=artifacts');
    expect(takeAuthReturnPath()).toBe('/projects/project/runs/run?tab=artifacts');
    expect(takeAuthReturnPath()).toBeNull();
  });
  it('外部URLを復帰先として保存しない', () => {
    const setItem = vi.fn();
    vi.stubGlobal('sessionStorage', { setItem });
    rememberAuthReturnPath('//example.invalid');
    expect(setItem).not.toHaveBeenCalled();
  });
});
