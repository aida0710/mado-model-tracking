import { afterEach, describe, expect, it, vi } from 'vitest';
import { executionApi } from './execution';

afterEach(() => vi.unstubAllGlobals());
function stubJsonResponse(body: unknown, status = 200) {
  // A Response body can be read once, so each call gets its own.
  const fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('checkpointの一覧と再開のAPI呼び出し', () => {
  it('既定では保持中のcheckpointだけを求め、切替時はincludeHiddenを付ける', async () => {
    const fetch = stubJsonResponse({ items: [] });
    await executionApi.listRunCheckpoints('project', 'run', {});
    await executionApi.listRunCheckpoints('project', 'run', { includeHidden: true });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/project/runs/run/checkpoints');
    expect(fetch.mock.calls[1]?.[0]).toBe(
      '/api/projects/project/runs/run/checkpoints?includeHidden=true',
    );
  });

  it('itemsの無い応答を空の一覧として扱わない', async () => {
    stubJsonResponse({});
    await expect(executionApi.listRunCheckpoints('project', 'run', {})).rejects.toThrow();
  });

  it('再実行は指定したcheckpointをJSONで送る', async () => {
    const fetch = stubJsonResponse({ run: { id: 'new-run' }, job: { id: 'new-job' } }, 201);
    await executionApi.retryJob('project', 'job', { checkpointId: 'checkpoint' });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/project/jobs/job/retry');
    expect(fetch.mock.calls[0]?.[1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ checkpointId: 'checkpoint' });
  });

  it('最初からの再実行は空のオブジェクトを送る', async () => {
    const fetch = stubJsonResponse({ run: { id: 'new-run' }, job: { id: 'new-job' } }, 201);
    await executionApi.retryJob('project', 'job', {});
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({});
  });

  it('別のcheckpointで再実行済みの409をサーバーの理由つきで返す', async () => {
    stubJsonResponse({ error: '別のcheckpointで再実行済みです', code: 'job_already_retried' }, 409);
    await expect(
      executionApi.retryJob('project', 'job', { resumeFromLatestCheckpoint: true }),
    ).rejects.toThrow('別のcheckpointで再実行済みです');
  });
});
