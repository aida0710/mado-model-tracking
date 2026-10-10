import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchersApi } from './launchers';

afterEach(() => vi.unstubAllGlobals());
function stubJsonResponse(body: unknown, status = 200) {
  // A Response body can be read once, so each call gets its own.
  const fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const created = { launcher: { id: 'launcher', name: 'main' }, token: 'mmt_secret' };

describe('launcherのAPI呼び出し', () => {
  it('一覧はlaunchersを読み、itemsの無い応答を拒否する', async () => {
    const fetch = stubJsonResponse({ items: [] });
    await expect(launchersApi.list()).resolves.toEqual([]);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/launchers');
    stubJsonResponse({});
    await expect(launchersApi.list()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('登録は名前をPOSTし、一度だけ返るtokenを返す', async () => {
    const fetch = stubJsonResponse(created, 201);
    await expect(launchersApi.create({ name: 'main' })).resolves.toEqual(created);
    expect(fetch.mock.calls[0]?.[1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body as string)).toEqual({ name: 'main' });
  });

  it('tokenかlauncherの無い応答は、tokenを見せられないので契約違反にする', async () => {
    stubJsonResponse({ launcher: { id: 'launcher' } }, 201);
    await expect(launchersApi.create({ name: 'main' })).rejects.toMatchObject({ code: 'invalid_response' });
    stubJsonResponse({ token: 'mmt_secret' }, 201);
    await expect(launchersApi.rotateToken('launcher')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('名前の重複をcodeつきで返す', async () => {
    stubJsonResponse({ error: '同じ名前のlauncherがあります', code: 'launcher_name_taken' }, 409);
    await expect(launchersApi.create({ name: 'main' })).rejects.toMatchObject({
      status: 409,
      code: 'launcher_name_taken',
    });
  });

  it('tokenの作り直しはPOST、失効はDELETE（204）でlauncherのIDを使う', async () => {
    const fetch = stubJsonResponse(created, 201);
    await expect(launchersApi.rotateToken('launcher/1')).resolves.toEqual(created);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/launchers/launcher%2F1/token');
    expect(fetch.mock.calls[0]?.[1].method).toBe('POST');
    const revoked = stubJsonResponse(null, 204);
    await expect(launchersApi.revoke('launcher/1')).resolves.toBeUndefined();
    expect(revoked.mock.calls[0]?.[0]).toBe('/api/launchers/launcher%2F1');
    expect(revoked.mock.calls[0]?.[1].method).toBe('DELETE');
  });
});
