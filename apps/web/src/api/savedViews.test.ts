import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedViewState } from '@mmt/contracts';
import { savedViewsApi } from './savedViews';
import { RequestError } from './http';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const state: SavedViewState = {
  version: 1,
  experimentIds: [],
  filter: '',
  orderBy: [],
  statuses: [],
  kinds: [],
  columns: [{ key: 'status' }],
  chartPanels: { version: 1, columns: 12, panels: [] },
};

afterEach(() => vi.unstubAllGlobals());
describe('保存ビューAPI', () => {
  it('一覧はページを指定して取得し、itemsの無い応答はエラーにする', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'v1' }] }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetch);
    await expect(savedViewsApi.list('p 1', 'runs')).resolves.toEqual([{ id: 'v1' }]);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/p%201/saved-views?page=runs');
    await expect(savedViewsApi.list('p 1', 'runs')).rejects.toThrow();
  });

  it('作成はPOSTで公開範囲・ページ・名前・状態を送る', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'v1' }, 201));
    vi.stubGlobal('fetch', fetch);
    await savedViewsApi.create('p', { visibility: 'project', page: 'runs', name: '比較', state });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/p/saved-views');
    expect(fetch.mock.calls[0]?.[1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
      visibility: 'project',
      page: 'runs',
      name: '比較',
      state,
    });
  });

  it('上書きはPATCHで変えた項目だけを送り、削除の204を成功として扱う', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'v/1' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await savedViewsApi.update('p', 'v/1', { state });
    await expect(savedViewsApi.remove('p', 'v/1')).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/p/saved-views/v%2F1');
    expect(fetch.mock.calls[0]?.[1].method).toBe('PATCH');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ state });
    expect(fetch.mock.calls[1]?.[1].method).toBe('DELETE');
  });

  it('見えないビュー（他人の自分用・削除済み）は404のRequestErrorになる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'not found', code: 'not_found' }, 404)),
    );
    const failure = await savedViewsApi.get('p', 'v1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RequestError);
    expect((failure as RequestError).status).toBe(404);
  });
});
