import { afterEach, describe, expect, it, vi } from 'vitest';
import { siteComputersApi } from './siteComputers';

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
const call = (fetch: ReturnType<typeof stubJsonResponse>, index = 0) => ({
  path: fetch.mock.calls[index]?.[0] as string,
  method: (fetch.mock.calls[index]?.[1]?.method as string | undefined) ?? 'GET',
  body: fetch.mock.calls[index]?.[1]?.body
    ? (JSON.parse(fetch.mock.calls[index]?.[1].body as string) as unknown)
    : undefined,
});

describe('計算機の共有とjob shellのAPI呼び出し', () => {
  it('共有するProjectはPUTで丸ごと置き換え、自分の計算機でない拒否をcodeつきで返す', async () => {
    const fetch = stubJsonResponse({ id: 'pc', projectIds: ['p1'] });
    await siteComputersApi.setProjects('pc/1', { projectIds: ['p1'] });
    expect(call(fetch)).toEqual({
      path: '/api/targets/pc%2F1/projects',
      method: 'PUT',
      body: { projectIds: ['p1'] },
    });
    stubJsonResponse({ error: '全体の計算機は共有先を持ちません', code: 'target_not_owned' }, 422);
    await expect(siteComputersApi.setProjects('site', { projectIds: [] })).rejects.toMatchObject({
      code: 'target_not_owned',
    });
  });

  it('版の一覧・1つの版・新しい版の保存はtargetのjob-shellsを使う', async () => {
    const fetch = stubJsonResponse({ items: [] });
    await expect(siteComputersApi.jobShells('site')).resolves.toEqual([]);
    await siteComputersApi.jobShell('site', 'shell/2');
    await siteComputersApi.createJobShell('site', { content: '#!/bin/sh\n' });
    expect(call(fetch, 0).path).toBe('/api/targets/site/job-shells');
    expect(call(fetch, 1).path).toBe('/api/targets/site/job-shells/shell%2F2');
    expect(call(fetch, 2)).toEqual({
      path: '/api/targets/site/job-shells',
      method: 'POST',
      body: { content: '#!/bin/sh\n' },
    });
  });

  it('itemsの無い版の一覧を空として扱わない', async () => {
    stubJsonResponse({});
    await expect(siteComputersApi.jobShells('site')).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('個人設定のAPI呼び出し', () => {
  it('自分の設定はまだ無ければnullで、itemの無い応答は契約違反にする', async () => {
    const fetch = stubJsonResponse({ item: null });
    await expect(siteComputersApi.myPersonalSettings('site')).resolves.toBeNull();
    expect(call(fetch).path).toBe('/api/targets/site/personal-settings/me');
    stubJsonResponse({});
    await expect(siteComputersApi.myPersonalSettings('site')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('保存はPUT、削除はDELETE（204）で、共用アカウントのsiteの拒否をcodeつきで返す', async () => {
    const fetch = stubJsonResponse({ targetId: 'site', accountName: 'alice' });
    await siteComputersApi.saveMyPersonalSettings('site', { accountName: 'alice', variables: {} });
    expect(call(fetch)).toEqual({
      path: '/api/targets/site/personal-settings/me',
      method: 'PUT',
      body: { accountName: 'alice', variables: {} },
    });
    const deleted = stubJsonResponse(null, 204);
    await expect(siteComputersApi.deleteMyPersonalSettings('site')).resolves.toBeUndefined();
    expect(call(deleted).method).toBe('DELETE');
    stubJsonResponse({ error: '共用アカウントの計算機に自分の設定はありません', code: 'site_settings_invalid' }, 422);
    await expect(siteComputersApi.saveMyPersonalSettings('shared', {})).rejects.toMatchObject({
      code: 'site_settings_invalid',
    });
  });

  it('全員の設定はpersonal-settingsを読む', async () => {
    const fetch = stubJsonResponse({ items: [] });
    await siteComputersApi.personalSettings('site');
    expect(call(fetch).path).toBe('/api/targets/site/personal-settings');
  });
});

describe('鍵と接続確認のAPI呼び出し', () => {
  it('鍵の作り直しは共用か本人かをPOSTする', async () => {
    const fetch = stubJsonResponse({ items: [] });
    await siteComputersApi.keys('site');
    await siteComputersApi.rotateKey('site', { personal: true });
    expect(call(fetch, 0).path).toBe('/api/targets/site/keys');
    expect(call(fetch, 1)).toEqual({
      path: '/api/targets/site/keys/rotate',
      method: 'POST',
      body: { personal: true },
    });
  });

  it('接続確認は共用か本人かで依頼・一覧を分け、実行中の409をcodeつきで返す', async () => {
    const fetch = stubJsonResponse({ items: [] });
    await siteComputersApi.connectionChecks('site', false);
    await siteComputersApi.connectionChecks('site', true);
    expect(call(fetch, 0).path).toBe('/api/targets/site/connection-checks?personal=false');
    expect(call(fetch, 1).path).toBe('/api/targets/site/connection-checks?personal=true');
    const requested = stubJsonResponse({ id: 'check', status: 'queued' }, 201);
    await siteComputersApi.requestConnectionCheck('site', { personal: false });
    expect(call(requested)).toEqual({
      path: '/api/targets/site/connection-checks',
      method: 'POST',
      body: { personal: false },
    });
    stubJsonResponse({ error: '確認中です', code: 'site_check_in_progress' }, 409);
    await expect(
      siteComputersApi.requestConnectionCheck('site', { personal: false }),
    ).rejects.toMatchObject({ status: 409, code: 'site_check_in_progress', serverMessage: '確認中です' });
  });
});
