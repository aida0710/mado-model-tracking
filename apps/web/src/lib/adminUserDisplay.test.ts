import { describe, expect, it } from 'vitest';
import { isSsoUser, userAuthSourceLabels } from './adminUserDisplay';

describe('ユーザーの認証方式の表示', () => {
  it('ローカルとSSOの両方を持つユーザーはSSOユーザーとして扱い、両方を表示する', () => {
    const user = { authSources: ['local', 'oidc'] as const };
    expect(isSsoUser({ authSources: [...user.authSources] })).toBe(true);
    expect(userAuthSourceLabels({ authSources: [...user.authSources], kind: 'human' })).toEqual([
      'ローカル',
      'SSO',
    ]);
  });

  it('どちらも持たない開発用ログインは「開発用」と表示する', () => {
    expect(isSsoUser({ authSources: [] })).toBe(false);
    expect(userAuthSourceLabels({ authSources: [], kind: 'human' })).toEqual(['開発用']);
  });

  it('Service Accountは開発用ログインと区別し、API tokenだけで動くと表示する', () => {
    expect(userAuthSourceLabels({ authSources: [], kind: 'service' })).toEqual(['API tokenのみ']);
  });
});
