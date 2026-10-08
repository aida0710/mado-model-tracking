import { afterEach, describe, expect, it, vi } from 'vitest';
import { authApi } from './auth';
import { RequestError } from './http';
import { changePasswordErrorMessage, localLoginErrorMessage } from '../lib/authErrorMessages';
import { text } from '../i18n/catalog';

afterEach(() => vi.unstubAllGlobals());

function respond(status: number, body: unknown) {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status }),
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function failure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the request to fail');
}

describe('authApi.localLogin', () => {
  it('cookieを受け取れるようにcredentials付きでJSONを送り、AuthMeを返す', async () => {
    const me = { user: { id: 'user' }, mustChangePassword: true };
    const fetch = respond(200, me);
    expect(await authApi.localLogin({ username: 'admin', password: 'secret value' })).toEqual(me);
    expect(fetch).toHaveBeenCalledWith('/api/auth/local-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret value' }),
      credentials: 'include',
    });
  });

  it('401は認証情報の誤り、429は待つよう促す文言に分ける', async () => {
    respond(401, { error: 'server text', code: 'invalid_credentials' });
    const invalid = await failure(() => authApi.localLogin({ username: 'a', password: 'b' }));
    expect(invalid).toBeInstanceOf(RequestError);
    expect(localLoginErrorMessage(invalid)).toBe(text.localLoginInvalid);
    respond(429, { error: 'server text', code: 'rate_limited' });
    const limited = await failure(() => authApi.localLogin({ username: 'a', password: 'b' }));
    expect(localLoginErrorMessage(limited)).toBe(text.loginRateLimited);
  });
});

describe('authApi.changePassword', () => {
  it('204を成功として扱う', async () => {
    const fetch = respond(204, null);
    await expect(
      authApi.changePassword({ currentPassword: 'old value', newPassword: 'new value' }),
    ).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]![0]).toBe('/api/auth/change-password');
  });

  it('現在のpasswordの誤り・弱いpassword・回数制限を区別する', async () => {
    const cases = [
      [401, 'invalid_credentials', text.currentPasswordInvalid],
      [422, 'weak_password', text.weakPassword],
      [403, 'local_account_required', text.localAccountRequired],
      [429, 'rate_limited', text.loginRateLimited],
    ] as const;
    for (const [status, code, message] of cases) {
      respond(status, { error: 'server text', code });
      const error = await failure(() =>
        authApi.changePassword({ currentPassword: 'old value', newPassword: 'new value' }),
      );
      expect(changePasswordErrorMessage(error)).toBe(message);
    }
  });
});
