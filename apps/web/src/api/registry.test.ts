import { afterEach, describe, expect, it, vi } from 'vitest';
import { registryApi } from './registry';

afterEach(() => vi.unstubAllGlobals());
describe('Model aliasの設定・解除・履歴', () => {
  it('理由が空なら送らず、入力があればバージョンと一緒に送る', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await registryApi.assignAlias('project', 'model', {
      alias: 'production',
      versionId: 'v1',
      reason: '',
    });
    await registryApi.assignAlias('project', 'model', {
      alias: 'production',
      versionId: 'v2',
      reason: 'WER改善',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/project/models/model/aliases/production');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ versionId: 'v1' });
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({
      versionId: 'v2',
      reason: 'WER改善',
    });
  });
  it('解除はDELETEで送り、204を成功として扱う', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await expect(registryApi.removeAlias('project', 'model', 'staging')).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[1].method).toBe('DELETE');
  });
  it('履歴は50件とcursorを指定し、nextCursorが欠けた応答はエラーにする', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: 'older' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await registryApi.aliasEvents('project', 'model', { cursor: 'last' })).toEqual({
      items: [],
      nextCursor: 'older',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/projects/project/models/model/alias-events?limit=50&cursor=last',
    );
    await expect(registryApi.aliasEvents('project', 'model')).rejects.toThrow();
  });
});
