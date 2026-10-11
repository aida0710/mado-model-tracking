import type {
  AuditEventPage,
  Job,
  Project,
  Run,
  RunResumeEventPage,
  RunResumeResult,
  RunStatus,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executionFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { trackingClient } from './mlflow-tracking-fixtures.js';

// update-run bodies MLflow 3.0.0 and 3.17.0 send for `with mlflow.start_run(run_id=X):`, captured
// from the real SDKs (artifacts/verification/2026-10-08/run-resume-api/). The reopening request
// carries the previous end_time; the closing one carries the new end time.
const START_RUN_REOPEN = { status: 'RUNNING', end_time: 1700000005000 };
const START_RUN_CLOSE = { status: 'FINISHED', end_time: 1791450259535 };
const NOW = '2026-10-08T00:00:00.000Z';

describe.skipIf(!testDatabaseUrl)('Runの再開（独立PostgreSQL）', () => {
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

  function resume(
    runId: string,
    options: { cookie?: string; token?: string; body?: unknown } = {},
  ) {
    return request(harness.app, `${fixture.basePath}/runs/${runId}/resume`, {
      method: 'POST',
      ...(options.token
        ? { token: options.token }
        : { cookie: options.cookie ?? fixture.editor.cookie }),
      body: options.body ?? {},
    });
  }

  async function resumeEvents(runId: string): Promise<RunResumeEventPage> {
    return entity<RunResumeEventPage>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}/resume-events`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  async function nativeRun(runId: string): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  async function errorCode(response: Response): Promise<string | undefined> {
    return ((await response.json()) as { code?: string }).code;
  }

  // Moves a Run without a Job through the native PATCH, like an SDK that reports its own status.
  async function patchStatus(runId: string, status: RunStatus): Promise<void> {
    await entity(
      await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { status },
      }),
      200,
    );
  }

  async function endedRun(status: Exclude<RunStatus, 'queued' | 'running'>): Promise<Run> {
    const run = await fixture.newRun('Resumable', 'training');
    await patchStatus(run.id, 'running');
    await patchStatus(run.id, status);
    return nativeRun(run.id);
  }

  async function logMetrics(runId: string, metrics: { name: string; step: number }[]) {
    const response = await request(harness.app, `${fixture.basePath}/runs/${runId}/metrics`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { metrics: metrics.map((metric) => ({ ...metric, value: 0.5, timestamp: NOW })) },
    });
    expect(response.status).toBe(204);
  }

  it('finished・failed・canceledのRunを再開するとrunningに戻りended_atとerrorが消え、eventが1件残る', async () => {
    for (const status of ['finished', 'failed', 'canceled'] as const) {
      const run = await endedRun(status);
      await harness.database.query("UPDATE runs SET error='OOM' WHERE id=$1", [run.id]);
      const result = await entity<RunResumeResult>(
        await resume(run.id, { body: { reason: '学習の続き' } }),
        200,
      );
      expect(result.resumed).toBe(true);
      expect(result.run).toMatchObject({
        id: run.id,
        status: 'running',
        endedAt: null,
        error: null,
      });
      expect(result.event).toMatchObject({
        runId: run.id,
        previousStatus: status,
        previousEndedAt: run.endedAt,
        maxStepAtResume: null,
        source: 'native',
        actorUserId: fixture.editor.userId,
        reason: '学習の続き',
      });
      const page = await resumeEvents(run.id);
      expect(page.items).toEqual([result.event]);
      expect((await nativeRun(run.id)).startedAt).toBe(run.startedAt);
    }
  });

  it('runningのRunへのresumeはresumed:falseでeventを残さない', async () => {
    const run = await trackingClient(harness.app, fixture).createRun();
    const result = await entity<RunResumeResult>(await resume(run.info.run_id), 200);
    expect(result).toMatchObject({ resumed: false, event: null, run: { status: 'running' } });
    expect((await resumeEvents(run.info.run_id)).items).toEqual([]);
  });

  it('lastStepsはmetricのkeyごとの最大stepで、maxStepAtResumeは全metricの最大step', async () => {
    const ended = await fixture.newRun('Metrics', 'training');
    await patchStatus(ended.id, 'running');
    await logMetrics(ended.id, [
      { name: 'loss', step: 3 },
      { name: 'loss', step: 120 },
      { name: 'accuracy', step: 40 },
    ]);
    await patchStatus(ended.id, 'failed');
    const result = await entity<RunResumeResult>(await resume(ended.id), 200);
    expect(result.lastSteps).toEqual({ accuracy: 40, loss: 120 });
    expect(result.event?.maxStepAtResume).toBe(120);
    expect((await resumeEvents(ended.id)).segments[1]?.firstStep).toBe(121);
  });

  it('Job付きRunは409 run_finalized、queuedは409 run_not_started、削除済みは409 run_deleted', async () => {
    const jobRun = await fixture.newRun('Job owned', 'training');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: jobRun.id, targetId: fixture.target.id },
      }),
    );
    const queued = await resume(jobRun.id);
    expect(queued.status).toBe(409);
    expect(await errorCode(queued)).toBe('run_not_started');
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    await harness.database.query('UPDATE runs SET started_at=$2 WHERE id=$1', [jobRun.id, NOW]);
    const finalized = await resume(jobRun.id);
    expect(finalized.status).toBe(409);
    expect(await errorCode(finalized)).toBe('run_finalized');

    const deleted = await endedRun('finished');
    await entity(
      await trackingClient(harness.app, fixture).post('/runs/delete', { run_id: deleted.id }),
      200,
    );
    const deletedResponse = await resume(deleted.id);
    expect(deletedResponse.status).toBe(409);
    expect(await errorCode(deletedResponse)).toBe('run_deleted');
    expect((await resumeEvents(jobRun.id)).items).toEqual([]);
    expect((await nativeRun(jobRun.id)).status).toBe('canceled');
  });

  it('別ProjectのURLからは404、viewerは403、Job tokenは自分のRunでも403', async () => {
    const run = await endedRun('finished');
    expect((await resume(run.id, { cookie: fixture.viewer.cookie })).status).toBe(403);
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const crossProject = await request(
      harness.app,
      `/api/projects/${other.id}/runs/${run.id}/resume`,
      {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: {},
      },
    );
    expect(crossProject.status).toBe(404);
    const crossEvents = await request(
      harness.app,
      `/api/projects/${other.id}/runs/${run.id}/resume-events`,
      {
        cookie: fixture.outsider.cookie,
      },
    );
    expect(crossEvents.status).toBe(404);

    const jobRun = await fixture.newRun('Job token', 'training');
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: jobRun.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const claimed = await entity<{ item: { jobToken: string } | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'resume-worker' },
      }),
      200,
    );
    const jobToken = claimed.item!.jobToken;
    expect((await resume(jobRun.id, { token: jobToken })).status).toBe(403);
    expect((await resumeEvents(run.id)).items).toEqual([]);
  });

  it('MLflow start_run(run_id=)のupdate-run RUNNINGでsource=mlflowのeventが残り、二度の再開で3区間になる', async () => {
    const client = trackingClient(harness.app, fixture);
    const created = await client.createRun();
    const runId = created.info.run_id;
    const update = (body: Record<string, unknown>) =>
      client.post('/runs/update', { run_id: runId, run_uuid: runId, ...body });
    await entity(await update({ status: 'FAILED', end_time: 1700000005000 }), 200);

    await entity(await update(START_RUN_REOPEN), 200);
    const reopened = await client.getRun(runId);
    expect(reopened.info.status).toBe('RUNNING');
    expect(reopened.info.end_time).toBeUndefined();
    await entity(await update(START_RUN_CLOSE), 200);

    await entity<RunResumeResult>(await resume(runId), 200);
    await entity(await update({ status: 'FINISHED' }), 200);

    const page = await resumeEvents(runId);
    expect(page.items.map((event) => [event.source, event.previousStatus])).toEqual([
      ['mlflow', 'failed'],
      ['native', 'finished'],
    ]);
    expect(page.items[0]).toMatchObject({
      previousEndedAt: new Date(1700000005000).toISOString(),
      actorUserId: fixture.editor.userId,
      reason: null,
    });
    const run = await nativeRun(runId);
    expect(page.segments).toEqual([
      {
        startedAt: run.startedAt,
        endedAt: new Date(1700000005000).toISOString(),
        endStatus: 'failed',
        firstStep: null,
      },
      {
        startedAt: page.items[0]!.resumedAt,
        endedAt: new Date(START_RUN_CLOSE.end_time).toISOString(),
        endStatus: 'finished',
        firstStep: null,
      },
      {
        startedAt: page.items[1]!.resumedAt,
        endedAt: run.endedAt,
        endStatus: 'finished',
        firstStep: null,
      },
    ]);
  });

  it('MLflowのupdate-runはrunningのRUNNINGとJob付きRunでは再開eventを残さない', async () => {
    const client = trackingClient(harness.app, fixture);
    const created = await client.createRun();
    await entity(
      await client.post('/runs/update', { run_id: created.info.run_id, status: 'RUNNING' }),
      200,
    );
    expect((await resumeEvents(created.info.run_id)).items).toEqual([]);

    const jobRun = await fixture.newRun('Job owned', 'training');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: jobRun.id, targetId: fixture.target.id },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    await entity(
      await client.post('/runs/update', { run_id: jobRun.id, ...START_RUN_REOPEN }),
      200,
    );
    expect((await nativeRun(jobRun.id)).status).toBe('canceled');
    expect((await resumeEvents(jobRun.id)).items).toEqual([]);
  });

  it('eventのUPDATE・DELETEはtriggerで拒否される', async () => {
    const run = await endedRun('finished');
    const { event } = await entity<RunResumeResult>(await resume(run.id), 200);
    await expect(
      harness.database.query("UPDATE run_resume_events SET reason='changed' WHERE id=$1", [
        event!.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      harness.database.query('DELETE FROM run_resume_events WHERE id=$1', [event!.id]),
    ).rejects.toThrow(/only be deleted by purging their Project/);
  });

  it('再開すると監査run.resumeが成功で残り、拒否はdeniedで残る', async () => {
    const run = await endedRun('failed');
    const { event } = await entity<RunResumeResult>(
      await resume(run.id, { body: { reason: 'x' } }),
      200,
    );
    expect((await resume(run.id, { cookie: fixture.viewer.cookie })).status).toBe(403);
    const audit = await entity<AuditEventPage>(
      await request(harness.app, `${fixture.basePath}/audit-events?action=run.resume`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    const resumeEvents = audit.items.filter((item) => item.action === 'run.resume');
    expect(resumeEvents.map((item) => item.outcome).sort()).toEqual(['denied', 'success']);
    expect(resumeEvents.find((item) => item.outcome === 'success')).toMatchObject({
      resourceType: 'run',
      resourceId: run.id,
      actorUserId: fixture.editor.userId,
      details: { eventId: event!.id, previousStatus: 'failed', hasReason: true },
    });
  });

  it('理由が上限を超えるか未知のfieldがあると422', async () => {
    const run = await endedRun('finished');
    expect((await resume(run.id, { body: { reason: 'a'.repeat(2001) } })).status).toBe(422);
    expect((await resume(run.id, { body: { force: true } })).status).toBe(422);
    expect((await nativeRun(run.id)).status).toBe('finished');
  });
});
