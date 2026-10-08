import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_MEDIA_MAX_ITEMS, RUN_MEDIA_PAGE_LIMIT, runMediaApi } from './runMedia';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const item = (step: number) => ({ id: `m${step}`, runId: 'run', key: 'samples', step });

afterEach(() => vi.unstubAllGlobals());
describe('Runのメディア', () => {
  it('キーの全件をcursorで辿り、step範囲などの条件を送る', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [item(0), item(1)], nextCursor: 'c1' }))
      .mockResolvedValueOnce(json({ items: [item(2)] }));
    vi.stubGlobal('fetch', fetch);
    const list = await runMediaApi.list('project', 'run', { key: 'eval/audio', kind: 'audio', stepFrom: 0 });
    expect(list).toEqual({ items: [item(0), item(1), item(2)], truncated: false });
    const [first, second] = fetch.mock.calls.map(([url]) => new URL(url as string, 'http://x'));
    expect(first!.pathname).toBe('/api/projects/project/runs/run/media');
    expect(Object.fromEntries(first!.searchParams)).toEqual({
      key: 'eval/audio',
      kind: 'audio',
      stepFrom: '0',
      limit: String(RUN_MEDIA_PAGE_LIMIT),
    });
    expect(second!.searchParams.get('cursor')).toBe('c1');
  });

  it('上限まで辿ったら打ち切りを知らせる', async () => {
    const fullPage = Array.from({ length: RUN_MEDIA_PAGE_LIMIT }, (_, index) => item(index));
    const fetch = vi.fn().mockImplementation(async () => json({ items: fullPage, nextCursor: 'more' }));
    vi.stubGlobal('fetch', fetch);
    const list = await runMediaApi.list('project', 'run', { key: 'samples' });
    expect(list.items).toHaveLength(RUN_MEDIA_MAX_ITEMS);
    expect(list.truncated).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(RUN_MEDIA_MAX_ITEMS / RUN_MEDIA_PAGE_LIMIT);
  });

  it('比較の格子はRun×stepの形でなければ契約違反として扱う', async () => {
    const valid = { key: 'k', steps: [0, 1], rows: [{ runId: 'a', cells: [null, null] }, { runId: 'b', cells: [null, null] }] };
    const latest = { key: 'k', steps: null, rows: [{ runId: 'a', cells: [null] }] };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(valid))
      .mockResolvedValueOnce(json({ ...valid, rows: [{ runId: 'a', cells: [null] }] }))
      .mockResolvedValueOnce(json(latest));
    vi.stubGlobal('fetch', fetch);
    await expect(runMediaApi.compare('project', { runIds: ['a', 'b'], key: 'k' })).resolves.toEqual(valid);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/project/media/compare');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ runIds: ['a', 'b'], key: 'k' });
    await expect(runMediaApi.compare('project', { runIds: ['a', 'b'], key: 'k' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await expect(runMediaApi.compare('project', { runIds: ['a'], key: 'k' })).resolves.toEqual(latest);
  });

  it('表は行の範囲を指定して取得し、権限エラーはそのまま投げる', async () => {
    const page = { columns: [{ name: 'image', type: 'image' }], rows: [[null]], totalRows: 1, offset: 50 };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(page))
      .mockResolvedValueOnce(json({ error: 'x', code: 'project_forbidden' }, 403));
    vi.stubGlobal('fetch', fetch);
    await expect(runMediaApi.table('project', { runId: 'run', mediaId: 'm/1' }, { offset: 50, limit: 50 })).resolves.toEqual(page);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/project/runs/run/media/m%2F1/table?offset=50&limit=50');
    await expect(runMediaApi.table('project', { runId: 'run', mediaId: 'm' }, { offset: 0, limit: 50 })).rejects.toMatchObject({
      status: 403,
      code: 'project_forbidden',
    });
  });
});
