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

describe('コンピュータの一覧と追加・編集のAPI呼び出し', () => {
  it('Compute画面は見られるコンピュータを全部、実行先の選択はProjectで使えるコンピュータだけを読む', async () => {
    const fetch = stubJsonResponse({ items: [] });
    await executionApi.targets();
    await executionApi.projectTargets('project/1');
    await executionApi.targetOverview();
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/targets');
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/targets?projectId=project%2F1');
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/targets/overview');
  });

  it('itemsの無い一覧を空として扱わない', async () => {
    stubJsonResponse({});
    await expect(executionApi.projectTargets('project')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('追加は公開範囲・siteの全体設定・最初のjob shellをPOSTし、編集は変えた値をPATCHする', async () => {
    const fetch = stubJsonResponse({ id: 'site' }, 201);
    const body = {
      name: 'PC',
      host: '',
      port: 22,
      username: '',
      sshKeyPath: '',
      knownHostsPath: '',
      workDirectory: '',
      pythonExecutable: '',
      runtimeKinds: ['docker' as const],
      gpuIds: [],
      maxConcurrentJobs: 1,
      enabled: true,
      executor: 'site' as const,
      datasetCacheMaxBytes: 1024 ** 3,
      datasetTransfer: 'direct' as const,
      submissionMode: 'manual' as const,
      cpuArch: 'amd64' as const,
      supportsArray: false,
      queueTimeoutSeconds: null,
      visibility: 'private' as const,
      site: { runnerPython: 'python3' },
      jobShell: '#!/bin/sh\n',
    };
    await executionApi.createTarget(body);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/targets');
    expect(fetch.mock.calls[0]?.[1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual(body);
    await executionApi.updateTarget('site/1', { enabled: false });
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/targets/site%2F1');
    expect(fetch.mock.calls[1]?.[1].method).toBe('PATCH');
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({ enabled: false });
  });

  it('全体管理者でない所有者がsite以外へ変えようとしたときの拒否を、サーバーの理由つきで返す', async () => {
    stubJsonResponse({ error: '全体管理者でない人が持てるコンピュータはsiteだけです' }, 403);
    await expect(executionApi.updateTarget('pc', { executor: 'ssh' })).rejects.toMatchObject({
      status: 403,
      serverMessage: '全体管理者でない人が持てるコンピュータはsiteだけです',
    });
  });
});
