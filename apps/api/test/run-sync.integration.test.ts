import { createHash, randomUUID } from 'node:crypto';
import type {
  ArtifactPresence,
  AuditEventPage,
  Job,
  LogEntry,
  MetricPoint,
  Project,
  Run,
  SyncBatch,
  SyncBatchResult,
  SyncRunCreate,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executionFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

const STARTED_AT = '2026-10-01T09:00:00.000Z';
const ENDED_AT = '2026-10-01T12:00:00.000Z';

describe.skipIf(!testDatabaseUrl)('オフライン記録の後送り（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Awaited<ReturnType<typeof executionFixture>>;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await executionFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  type Caller = { cookie?: string; token?: string; basePath?: string };

  function as(caller: Caller) {
    return caller.token
      ? { token: caller.token }
      : { cookie: caller.cookie ?? fixture.editor.cookie };
  }

  function syncRunBody(overrides: Partial<SyncRunCreate> = {}): SyncRunCreate {
    return {
      experimentId: fixture.experiment.id,
      name: 'Offline training',
      kind: 'training',
      parameters: { lr: 0.001 },
      tags: { cluster: 'hpc-cluster' },
      startedAt: STARTED_AT,
      origin: 'gpu-node-1',
      ...overrides,
    };
  }

  function putRun(runId: string, body: unknown = syncRunBody(), caller: Caller = {}) {
    return request(harness.app, `${caller.basePath ?? fixture.basePath}/sync/runs/${runId}`, {
      method: 'PUT',
      ...as(caller),
      body,
    });
  }

  function postBatch(runId: string, batch: unknown, caller: Caller = {}) {
    return request(
      harness.app,
      `${caller.basePath ?? fixture.basePath}/sync/runs/${runId}/batches`,
      { method: 'POST', ...as(caller), body: batch },
    );
  }

  function checkArtifacts(runId: string, items: unknown[], caller: Caller = {}) {
    return request(
      harness.app,
      `${caller.basePath ?? fixture.basePath}/sync/runs/${runId}/artifacts/check`,
      { method: 'POST', ...as(caller), body: { items } },
    );
  }

  async function syncedRun(runId = randomUUID()): Promise<Run> {
    return entity<Run>(await putRun(runId), 201);
  }

  function metricBatch(sequence: number, steps: number[]): SyncBatch {
    return {
      batchId: randomUUID(),
      sequence,
      metrics: steps.map((step) => ({
        name: 'loss',
        value: 1 / (step + 1),
        step,
        timestamp: new Date(Date.parse(STARTED_AT) + step * 1000).toISOString(),
      })),
      logs: [
        {
          timestamp: STARTED_AT,
          level: 'info',
          message: `batch ${sequence}`,
        },
      ],
    };
  }

  async function nativeRun(runId: string): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  async function runMetrics(runId: string): Promise<MetricPoint[]> {
    const page = await entity<{ items: MetricPoint[] }>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}/metrics`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    return page.items;
  }

  async function runLogs(runId: string): Promise<LogEntry[]> {
    const page = await entity<{ items: LogEntry[] }>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}/logs`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    return page.items;
  }

  async function errorCode(response: Response): Promise<string | undefined> {
    return ((await response.json()) as { code?: string }).code;
  }

  async function claimedJobToken(runId: string): Promise<string> {
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const claimed = await entity<{ item: { jobToken: string } | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'sync-worker' },
      }),
      200,
    );
    return claimed.item!.jobToken;
  }

  it('PUTで指定したIDのRunがrunningでできて、2回目は同じRunを返し監査は作成時の1件だけ', async () => {
    const runId = randomUUID();
    const created = await entity<Run>(await putRun(runId), 201);
    expect(created).toMatchObject({
      id: runId,
      status: 'running',
      startedAt: STARTED_AT,
      createdBy: fixture.editor.userId,
      parameters: { lr: 0.001 },
      tags: { cluster: 'hpc-cluster' },
      syncOrigin: 'gpu-node-1',
    });
    const again = await entity<Run>(await putRun(runId, syncRunBody({ name: 'Renamed' })), 200);
    expect(again).toMatchObject({
      id: runId,
      name: 'Offline training',
      status: 'running',
    });
    const audit = await entity<AuditEventPage>(
      await request(harness.app, `${fixture.basePath}/audit-events?action=run.sync.create`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    const syncEvents = audit.items.filter((item) => item.action === 'run.sync.create');
    expect(syncEvents).toHaveLength(1);
    expect(syncEvents[0]).toMatchObject({
      outcome: 'success',
      resourceType: 'run',
      resourceId: runId,
      actorUserId: fixture.editor.userId,
    });
  });

  it('他人のRunとJob付きRunのIDは409 sync_run_conflictで、Runは変わらない', async () => {
    const othersRunId = randomUUID();
    await entity<Run>(await putRun(othersRunId, syncRunBody(), fixture.administrator), 201);
    const othersResponse = await putRun(othersRunId);
    expect(othersResponse.status).toBe(409);
    expect(await errorCode(othersResponse)).toBe('sync_run_conflict');
    const othersBatch = await postBatch(othersRunId, metricBatch(0, [0]));
    expect(othersBatch.status).toBe(409);

    const jobRun = await fixture.newRun('Job run', 'training');
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: jobRun.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const jobResponse = await putRun(jobRun.id);
    expect(jobResponse.status).toBe(409);
    expect(await errorCode(jobResponse)).toBe('sync_run_conflict');
    expect((await postBatch(jobRun.id, metricBatch(0, [0]))).status).toBe(409);
    expect(await runMetrics(jobRun.id)).toEqual([]);
    expect((await nativeRun(jobRun.id)).status).toBe('queued');
  });

  it('startedAtは許容幅（300秒）までの未来なら受け付け、それより先は422', async () => {
    const tooFar = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const rejected = await putRun(randomUUID(), syncRunBody({ startedAt: tooFar }));
    expect(rejected.status).toBe(422);
    expect(await errorCode(rejected)).toBe('sync_timestamp_in_future');
    const slightlyAhead = new Date(Date.now() + 60 * 1000).toISOString();
    expect((await putRun(randomUUID(), syncRunBody({ startedAt: slightlyAhead }))).status).toBe(
      201,
    );
  });

  it('同じbatchを2回送るとmetricsとlogsは1回分で、2回目はduplicateと最初の件数を返す', async () => {
    const run = await syncedRun();
    const batch = {
      ...metricBatch(0, [0, 1, 2]),
      params: { epochs: 3 },
      tags: { stage: 'a' },
    };
    const first = await entity<SyncBatchResult>(await postBatch(run.id, batch), 200);
    expect(first).toEqual({
      applied: true,
      duplicate: false,
      counts: { metrics: 3, params: 1, tags: 1, logs: 1 },
    });
    const second = await entity<SyncBatchResult>(await postBatch(run.id, batch), 200);
    expect(second).toEqual({ ...first, applied: false, duplicate: true });

    const metrics = await runMetrics(run.id);
    expect(metrics.map((metric) => [metric.step, metric.timestamp])).toEqual([
      [0, STARTED_AT],
      [1, '2026-10-01T09:00:01.000Z'],
      [2, '2026-10-01T09:00:02.000Z'],
    ]);
    expect(await runLogs(run.id)).toHaveLength(1);
    expect(await nativeRun(run.id)).toMatchObject({
      parameters: { lr: 0.001, epochs: 3 },
      tags: { cluster: 'hpc-cluster', stage: 'a' },
      latestMetrics: { loss: 1 / 3 },
    });
  });

  it('同じbatchIdを同時に2本送っても片方だけが入る', async () => {
    const run = await syncedRun();
    const batch = metricBatch(0, [0, 1]);
    const results = await Promise.all([postBatch(run.id, batch), postBatch(run.id, batch)]);
    const bodies = await Promise.all(
      results.map((response) => entity<SyncBatchResult>(response, 200)),
    );
    expect(bodies.map((body) => body.applied).sort()).toEqual([false, true]);
    expect(await runMetrics(run.id)).toHaveLength(2);
    expect(await runLogs(run.id)).toHaveLength(1);
  });

  it('記録済みparamに別の値を送ると409で、そのbatchは何も残さず再送もできる', async () => {
    const run = await syncedRun();
    const sameValue = { ...metricBatch(0, [0]), params: { lr: 0.001 } };
    expect((await entity<SyncBatchResult>(await postBatch(run.id, sameValue), 200)).applied).toBe(
      true,
    );
    const contradicting = { ...metricBatch(1, [1]), params: { lr: 0.01 } };
    const response = await postBatch(run.id, contradicting);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('sync_param_conflict');
    expect(await runMetrics(run.id)).toHaveLength(1);
    // The refused batch left no record of its ID, so it is refused again rather than "duplicate".
    expect((await postBatch(run.id, contradicting)).status).toBe(409);
    expect((await nativeRun(run.id)).parameters).toEqual({ lr: 0.001 });
  });

  it('status付きbatchで終わったRunにも、後から届いた古いsequenceのbatchが入る', async () => {
    const run = await syncedRun();
    const last = {
      ...metricBatch(2, [20]),
      status: {
        status: 'failed',
        endedAt: ENDED_AT,
        error: 'CUDA out of memory',
      },
    };
    expect((await entity<SyncBatchResult>(await postBatch(run.id, last), 200)).applied).toBe(true);
    expect(await nativeRun(run.id)).toMatchObject({
      status: 'failed',
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      error: 'CUDA out of memory',
    });
    const older = await entity<SyncBatchResult>(await postBatch(run.id, metricBatch(1, [10])), 200);
    expect(older.applied).toBe(true);
    expect((await runMetrics(run.id)).map((metric) => metric.step)).toEqual([10, 20]);
    // Resending the end in a new batch changes nothing; a different end is refused.
    const sameEnd = { ...metricBatch(3, []), status: last.status };
    expect((await postBatch(run.id, sameEnd)).status).toBe(200);
    const otherEnd = {
      ...metricBatch(4, []),
      status: { status: 'finished', endedAt: ENDED_AT },
    };
    const refused = await postBatch(run.id, otherEnd);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe('sync_status_conflict');
    const stored = await harness.database.query<{
      batch_id: string;
      status_applied: string;
    }>(
      'SELECT batch_id,status_applied FROM run_sync_batches WHERE run_id=$1 AND status_applied IS NOT NULL',
      [run.id],
    );
    expect(stored.rows).toEqual([{ batch_id: last.batchId, status_applied: 'failed' }]);
    expect((await nativeRun(run.id)).status).toBe('failed');
  });

  it('endedAtが開始より前か未来すぎるstatusは422', async () => {
    const run = await syncedRun();
    const beforeStart = {
      ...metricBatch(0, []),
      status: { status: 'finished', endedAt: '2026-09-30T00:00:00.000Z' },
    };
    const response = await postBatch(run.id, beforeStart);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('sync_ended_before_start');
    const future = {
      ...metricBatch(0, []),
      status: {
        status: 'finished',
        endedAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    };
    expect((await postBatch(run.id, future)).status).toBe(422);
    expect((await nativeRun(run.id)).status).toBe('running');
  });

  it('batchは通常のJSON上限（4MiB）を超えても受け付け、件数の上限を超えると422', async () => {
    const run = await syncedRun();
    const longLogs = Array.from({ length: 50 }, (_, index) => ({
      timestamp: STARTED_AT,
      level: 'info' as const,
      message: `${index}:${'x'.repeat(100000)}`,
    }));
    const large = { batchId: randomUUID(), sequence: 0, logs: longLogs };
    expect(JSON.stringify(large).length).toBeGreaterThan(4 * 1024 * 1024);
    expect((await entity<SyncBatchResult>(await postBatch(run.id, large), 200)).counts.logs).toBe(
      50,
    );
    const ordinary = await request(harness.app, `${fixture.basePath}/runs/${run.id}/logs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { entries: longLogs },
    });
    expect(ordinary.status).toBe(413);
    const tooMany = metricBatch(
      1,
      Array.from({ length: 10001 }, (_, step) => step),
    );
    expect((await postBatch(run.id, tooMany)).status).toBe(422);
  });

  it('artifacts/checkは同じpath・sha256・sizeの保存済みArtifactだけをpresentにする', async () => {
    const run = await syncedRun();
    const content = 'checkpoint bytes';
    const digest = createHash('sha256').update(content).digest('hex');
    await entity(
      await request(
        harness.app,
        `${fixture.basePath}/runs/${run.id}/artifacts?path=${encodeURIComponent('ckpt/model.bin')}`,
        {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: content,
          headers: { 'Content-Type': 'application/octet-stream' },
        },
      ),
    );
    const size = Buffer.byteLength(content);
    const presence = await entity<ArtifactPresence>(
      await checkArtifacts(run.id, [
        { path: 'ckpt/model.bin', sha256: digest, size },
        { path: 'ckpt/other.bin', sha256: digest, size },
      ]),
      200,
    );
    expect(presence.present).toEqual(['ckpt/model.bin']);
    const differentDigest = await entity<ArtifactPresence>(
      await checkArtifacts(run.id, [{ path: 'ckpt/model.bin', sha256: 'f'.repeat(64), size }]),
      200,
    );
    expect(differentDigest.present).toEqual([]);
    const differentSize = await entity<ArtifactPresence>(
      await checkArtifacts(run.id, [{ path: 'ckpt/model.bin', sha256: digest, size: size + 1 }]),
      200,
    );
    expect(differentSize.present).toEqual([]);
    // A newer upload at the same path replaces what the Run shows, so the old digest is stale.
    await entity(
      await request(
        harness.app,
        `${fixture.basePath}/runs/${run.id}/artifacts?path=${encodeURIComponent('ckpt/model.bin')}`,
        {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'newer bytes',
          headers: { 'Content-Type': 'application/octet-stream' },
        },
      ),
    );
    const stale = await entity<ArtifactPresence>(
      await checkArtifacts(run.id, [{ path: 'ckpt/model.bin', sha256: digest, size }]),
      200,
    );
    expect(stale.present).toEqual([]);
    expect(
      (await checkArtifacts(run.id, [{ path: '../escape', sha256: digest, size }])).status,
    ).toBe(422);
  });

  it('viewerとJob tokenは403で、何も作られない', async () => {
    const run = await syncedRun();
    const viewer = { cookie: fixture.viewer.cookie };
    expect((await putRun(randomUUID(), syncRunBody(), viewer)).status).toBe(403);
    expect((await postBatch(run.id, metricBatch(0, [0]), viewer)).status).toBe(403);
    expect((await checkArtifacts(run.id, [], viewer)).status).toBe(403);

    const jobRun = await fixture.newRun('Job token', 'training');
    const jobToken = { token: await claimedJobToken(jobRun.id) };
    expect((await putRun(randomUUID(), syncRunBody(), jobToken)).status).toBe(403);
    expect((await postBatch(jobRun.id, metricBatch(0, [0]), jobToken)).status).toBe(403);
    expect((await checkArtifacts(jobRun.id, [], jobToken)).status).toBe(403);
    expect(await runMetrics(run.id)).toEqual([]);
    expect(await runMetrics(jobRun.id)).toEqual([]);
  });

  it('予約tagはRun作成でもbatchでも422', async () => {
    const reservedCreate = await putRun(
      randomUUID(),
      syncRunBody({ tags: { 'automation.ruleId': 'x' } }),
    );
    expect(reservedCreate.status).toBe(422);
    expect(await errorCode(reservedCreate)).toBe('reserved_tag');
    const run = await syncedRun();
    const reservedBatch = await postBatch(run.id, {
      ...metricBatch(0, [0]),
      tags: { 'mmt.x': 'y' },
    });
    expect(reservedBatch.status).toBe(422);
    expect(await runMetrics(run.id)).toEqual([]);
  });

  it('所属していないProjectは403で、別ProjectのURLから自分のRunを指すと404', async () => {
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherBase = `/api/projects/${other.id}`;
    expect((await putRun(randomUUID(), syncRunBody(), { basePath: otherBase })).status).toBe(403);

    const run = await syncedRun();
    const outsider = { cookie: fixture.outsider.cookie, basePath: otherBase };
    expect((await postBatch(run.id, metricBatch(0, [0]), outsider)).status).toBe(404);
    expect((await checkArtifacts(run.id, [], outsider)).status).toBe(404);
    expect(await runMetrics(run.id)).toEqual([]);
  });

  it('既存のRun作成はサーバーがIDを決めてqueuedで作り、syncOriginは持たない', async () => {
    const run = await fixture.newRun('Online', 'inference');
    expect(run.status).toBe('queued');
    expect(run.startedAt).toBeNull();
    expect((await nativeRun(run.id)).syncOrigin).toBeNull();
    // Only the sync route accepts a client-chosen ID.
    const withId = await request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        experimentId: fixture.experiment.id,
        name: 'Client id',
        kind: 'training',
        id: randomUUID(),
      },
    });
    expect(withId.status).toBe(422);
  });
});
