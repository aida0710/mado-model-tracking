import { afterEach, describe, expect, it, vi } from 'vitest';
import { commentsApi } from './comments';
import { runNotesApi } from './runNotes';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());
describe('コメントAPI', () => {
  it('一覧は対象とページ件数を送り、2ページ目からcursorを付ける', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetch);
    await commentsApi.list('p 1', { targetType: 'model_version', targetId: 'v/1' });
    await commentsApi.list('p 1', { targetType: 'run', targetId: 'r1' }, { cursor: 'c9' });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/projects/p%201/comments?targetType=model_version&targetId=v%2F1&limit=100',
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      '/api/projects/p%201/comments?targetType=run&targetId=r1&limit=100&cursor=c9',
    );
  });

  it('nextCursorが欠けた一覧の応答はエラーにする', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [] })));
    await expect(
      commentsApi.list('p', { targetType: 'run', targetId: 'r' }),
    ).rejects.toThrow();
  });

  it('投稿はPOSTで対象・返信先・本文を送る', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'c1' }, 201));
    vi.stubGlobal('fetch', fetch);
    await commentsApi.create('p', {
      targetType: 'run',
      targetId: 'r1',
      parentCommentId: 'root',
      body: '再現しました',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/p/comments');
    expect(fetch.mock.calls[0]?.[1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
      targetType: 'run',
      targetId: 'r1',
      parentCommentId: 'root',
      body: '再現しました',
    });
  });

  it('編集はPATCHで本文だけを送り、削除はDELETEの204を成功として扱う', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await commentsApi.update('p', 'c1', { body: '直しました' });
    await expect(commentsApi.remove('p', 'c1')).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/p/comments/c1');
    expect(fetch.mock.calls[0]?.[1].method).toBe('PATCH');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ body: '直しました' });
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/projects/p/comments/c1');
    expect(fetch.mock.calls[1]?.[1].method).toBe('DELETE');
  });
});

describe('Runの説明文API', () => {
  it('PUT /runs/:r/note に説明文を送る', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ runId: 'r1', content: '# 結果' }));
    vi.stubGlobal('fetch', fetch);
    expect(await runNotesApi.update('p', 'r1', { content: '# 結果' })).toEqual({
      runId: 'r1',
      content: '# 結果',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/p/runs/r1/note');
    expect(fetch.mock.calls[0]?.[1].method).toBe('PUT');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ content: '# 結果' });
  });
});
