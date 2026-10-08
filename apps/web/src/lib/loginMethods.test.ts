import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '@mmt/contracts';
import { loginMethods } from './loginMethods';

const sso = { label: 'Authentik', loginUrl: '/api/auth/login' };
const config = (mode: AuthConfig['mode'], local: boolean, oidc: typeof sso | null): AuthConfig => ({
  mode,
  methods: { local, oidc },
});

describe('loginMethods', () => {
  it('local modeはローカルアカウントのフォームだけを出す', () => {
    expect(loginMethods(config('local', true, null))).toEqual({
      development: false,
      sso: null,
      local: true,
    });
  });

  it('oidc modeはSSOのボタンだけを出す', () => {
    expect(loginMethods(config('oidc', false, sso))).toEqual({
      development: false,
      sso,
      local: false,
    });
  });

  it('hybrid modeはSSOとローカルアカウントの両方を出す', () => {
    expect(loginMethods(config('hybrid', true, sso))).toEqual({
      development: false,
      sso,
      local: true,
    });
  });

  it('development modeは開発用ログインだけを出す', () => {
    expect(loginMethods(config('development', false, null))).toEqual({
      development: true,
      sso: null,
      local: false,
    });
  });
});
