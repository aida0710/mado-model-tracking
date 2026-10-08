import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dataset, ModelVersion, PluginConnection, Run, RunStatus } from '@mmt/contracts';
import type { Principal } from '../src/auth/principal.js';
import { jobCreateSchema } from '../src/domain/validation.js';
import { RunTrackingService } from '../src/mlflow/tracking/runTrackingService.js';
import { JobService } from '../src/services/jobService.js';
import {
  RunCompletionService,
  type RunCompletionHandler,
} from '../src/services/runCompletionService.js';
import { RunService } from '../src/services/runService.js';
import { RunOutputDeclarationService } from '../src/services/runOutputDeclarationService.js';
import { WorkerService } from '../src/services/workerService.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

interface RecordedCompletion {
  runId: string;
  previousStatus: RunStatus;
  status: RunStatus;
}

const trackingDataset = {
  name: 'late-dataset',
  digest: 'late123',
  source_type: 'http',
  source: '{"uri":"http://127.0.0.1:1/do-not-fetch"}',
};

function recordingHandler(): RunCompletionHandler & {
  calls: RecordedCompletion[];
} {
  const calls: RecordedCompletion[] = [];
  return {
    name: 'recording',
    calls,
    async handle(_connection, { previousStatus, run }) {
      calls.push({ runId: run.id, previousStatus, status: run.status });
    },
  };
}

describe.skipIf(!testDatabaseUrl)('Run終端handlerの共通入口（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness?.close();
  });

  // The application composes no terminal handlers yet, so tests compose services around their own.
  function servicesWith(handlers: RunCompletionHandler[]) {
    const { database, config } = harness;
    const runCompletion = new RunCompletionService(handlers);
    const runs = new RunService(database, runCompletion);
    const jobs = new JobService({ database, runs, config, runCompletion });
    const worker = new WorkerService({
      database,
      jobs,
      config,
      runCompletion,
      outputDeclarations: new RunOutputDeclarationService(harness.services.registry),
    });
    const tracking = new RunTrackingService({
      database,
      runs,
      registry: harness.services.registry,
      runCompletion,
    });
    return { runs, jobs, worker, tracking };
  }

  async function sessionPrincipal(cookie: string): Promise<Principal> {
    const session = cookie.slice(cookie.indexOf('=') + 1);
    return (await harness.services.auth.authenticate({ session }))!;
  }

  async function setup() {
    const fixture = await executionFixture(harness);
    await entity<PluginConnection>(
      await request(harness.app, `${fixture.basePath}/plugins`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Lineage',
          baseUrl: 'http://127.0.0.1:4999',
          tokenEnv: 'MMT_TEST_PLUGIN_TOKEN',
        },
      }),
    );
    const editor = await sessionPrincipal(fixture.editor.cookie);
    const worker = (await harness.services.auth.authenticate({
      bearer: fixture.workerToken,
    }))!;
    return { ...fixture, editorPrincipal: editor, workerPrincipal: worker };
  }

  async function outboxEventTypes(runId: string): Promise<string[]> {
    const stored = await harness.database.query<{ type: string }>(
      "SELECT event->>'type' AS type FROM plugin_outbox WHERE event->'run'->>'id'=$1 ORDER BY created_at",
      [runId],
    );
    return stored.rows.map((row) => row.type);
  }

  it('worker completeでhandlerを1回だけ呼び、同じleaseの再送では呼ばず、claimのrunningでも呼ばない', async () => {
    const fixture = await setup();
    const handler = recordingHandler();
    const services = servicesWith([handler]);
    const run = await fixture.newRun();
    const job = await services.jobs.create(
      fixture.editorPrincipal,
      fixture.project.id,
      jobCreateSchema.parse({
        runId: run.id,
        targetId: fixture.target.id,
        gpuIds: ['0'],
      }),
    );
    const claimed = await services.worker.claim(fixture.workerPrincipal, {
      workerId: 'worker-one',
    });
    expect(claimed?.job.id).toBe(job.id);
    expect(handler.calls).toEqual([]);
    expect(await outboxEventTypes(run.id)).toEqual(['run.started']);

    const completion = {
      leaseId: claimed!.job.leaseId!,
      status: 'finished' as const,
      exitCode: 0,
    };
    await services.worker.complete(fixture.workerPrincipal, job.id, completion);
    await services.worker.complete(fixture.workerPrincipal, job.id, completion);

    expect(handler.calls).toEqual([
      { runId: run.id, previousStatus: 'running', status: 'finished' },
    ]);
    expect(await outboxEventTypes(run.id)).toEqual(['run.started', 'run.finished']);
  });

  it('queued Jobのcancelでhandlerを1回呼ぶ', async () => {
    const fixture = await setup();
    const handler = recordingHandler();
    const services = servicesWith([handler]);
    const run = await fixture.newRun();
    const job = await services.jobs.create(
      fixture.editorPrincipal,
      fixture.project.id,
      jobCreateSchema.parse({ runId: run.id, targetId: fixture.target.id }),
    );
    await services.jobs.cancel(fixture.editorPrincipal, fixture.project.id, job.id);
    await services.jobs.cancel(fixture.editorPrincipal, fixture.project.id, job.id);

    expect(handler.calls).toEqual([
      { runId: run.id, previousStatus: 'queued', status: 'canceled' },
    ]);
    expect(await outboxEventTypes(run.id)).toEqual(['run.canceled']);
  });

  it('native PATCHはfinishedへの変化でだけhandlerを呼び、runningへの変化はoutboxにだけ積む', async () => {
    const fixture = await setup();
    const handler = recordingHandler();
    const services = servicesWith([handler]);
    const run = await fixture.newRun();
    for (const status of ['running', 'finished', 'finished'] as const)
      await services.runs.patch(fixture.editorPrincipal, fixture.project.id, {
        runId: run.id,
        input: { status },
      });

    expect(handler.calls).toEqual([
      { runId: run.id, previousStatus: 'running', status: 'finished' },
    ]);
    expect(await outboxEventTypes(run.id)).toEqual(['run.started', 'run.finished']);
  });

  it('MLflow UpdateRun FINISHEDでhandlerを1回呼び、CreateRunでは呼ばない。終端後のDataset追加と出力登録は再送だけ積む', async () => {
    const fixture = await setup();
    const handler = recordingHandler();
    const services = servicesWith([handler]);
    const created = await services.tracking.create(fixture.editorPrincipal, fixture.project.id, {
      experiment_id: fixture.experiment.id,
      tags: [],
    });
    const runId = created.info.run_id;
    expect(handler.calls).toEqual([]);
    expect(await outboxEventTypes(runId)).toEqual(['run.started']);

    for (let attempt = 0; attempt < 2; attempt++)
      await services.tracking.update(fixture.editorPrincipal, fixture.project.id, {
        runId,
        status: 'FINISHED',
      });
    expect(handler.calls).toEqual([{ runId, previousStatus: 'running', status: 'finished' }]);
    expect(await outboxEventTypes(runId)).toEqual(['run.started', 'run.finished']);

    await services.tracking.inputs(fixture.editorPrincipal, fixture.project.id, {
      runId,
      datasets: [{ dataset: trackingDataset, tags: [] }],
      models: [],
    });
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { namespace: 'local', name: 'Late outputs' },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v1',
          uri: 's3://fixture/out',
          digest: 'sha256:out',
          sourceRunId: runId,
        },
      }),
    );

    expect(handler.calls).toHaveLength(1);
    expect(await outboxEventTypes(runId)).toEqual([
      'run.started',
      'run.finished',
      'run.finished',
      'run.finished',
    ]);
  });

  it('MLflowで終端から別の終端へ変えてもhandlerは呼ばず、RUNNINGへ戻してから終端にすると再び呼ぶ', async () => {
    const fixture = await setup();
    const handler = recordingHandler();
    const services = servicesWith([handler]);
    const created = await services.tracking.create(fixture.editorPrincipal, fixture.project.id, {
      experiment_id: fixture.experiment.id,
      tags: [],
    });
    const runId = created.info.run_id;
    for (const status of ['FINISHED', 'FAILED', 'RUNNING', 'FINISHED'] as const)
      await services.tracking.update(fixture.editorPrincipal, fixture.project.id, {
        runId,
        status,
      });

    expect(handler.calls).toEqual([
      { runId, previousStatus: 'running', status: 'finished' },
      { runId, previousStatus: 'running', status: 'finished' },
    ]);
    expect(await outboxEventTypes(runId)).toEqual([
      'run.started',
      'run.finished',
      'run.failed',
      'run.started',
      'run.finished',
    ]);
  });

  it('handlerが例外を出してもRunとJobは終端で確定し、GPU予約を解放して後続handlerを呼ぶ', async () => {
    const fixture = await setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: RunCompletionHandler = {
      name: 'failing',
      async handle(connection, { run }) {
        await connection.query("UPDATE runs SET name='written by failing handler' WHERE id=$1", [
          run.id,
        ]);
        throw new Error('handler bug');
      },
    };
    const following = recordingHandler();
    const services = servicesWith([failing, following]);
    const run = await fixture.newRun('Original name');
    const job = await services.jobs.create(
      fixture.editorPrincipal,
      fixture.project.id,
      jobCreateSchema.parse({
        runId: run.id,
        targetId: fixture.target.id,
        gpuIds: ['0'],
      }),
    );
    const claimed = await services.worker.claim(fixture.workerPrincipal, {
      workerId: 'worker-one',
    });
    try {
      const completed = await services.worker.complete(fixture.workerPrincipal, job.id, {
        leaseId: claimed!.job.leaseId!,
        status: 'failed',
        exitCode: 1,
      });
      expect(completed.status).toBe('failed');
      const stored = await harness.database.query<{
        status: string;
        name: string;
      }>('SELECT status,name FROM runs WHERE id=$1', [run.id]);
      expect(stored.rows[0]).toEqual({
        status: 'failed',
        name: 'Original name',
      });
      expect((await harness.database.query('SELECT job_id FROM gpu_reservations')).rows).toEqual(
        [],
      );
      expect(following.calls).toEqual([
        { runId: run.id, previousStatus: 'running', status: 'failed' },
      ]);
      expect(await outboxEventTypes(run.id)).toEqual(['run.started', 'run.failed']);
      expect(JSON.parse(consoleError.mock.calls[0]![0] as string)).toEqual({
        event: 'run_completion_handler_failed',
        handler: 'failing',
        runId: run.id,
        message: 'handler bug',
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  async function finishedEventOutputModels(runId: string): Promise<unknown[]> {
    const stored = await harness.database.query<{ ids: unknown }>(
      `SELECT event->'run'->'outputModelVersionIds' AS ids FROM plugin_outbox
      WHERE event->'run'->>'id'=$1 AND event->>'type'='run.finished' ORDER BY created_at`,
      [runId],
    );
    return stored.rows.map((row) => row.ids);
  }

  function outputModelRecorder(): RunCompletionHandler & { outputs: string[][] } {
    const outputs: string[][] = [];
    return {
      name: 'output-models',
      outputs,
      async handle(_connection, { run }) {
        outputs.push(run.outputModelVersionIds);
      },
    };
  }

  it('作成・PATCHの応答と終端handlerに渡るRunは出力モデル版を持つ', async () => {
    const fixture = await setup();
    const handler = outputModelRecorder();
    const services = servicesWith([handler]);
    const run = await fixture.newRun('Training', 'training');
    expect(run.outputModelVersionIds).toEqual([]);
    const version = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { sourceRunId: run.id },
      }),
    );
    const running = await services.runs.patch(fixture.editorPrincipal, fixture.project.id, {
      runId: run.id,
      input: { status: 'running' },
    });
    expect(running.outputModelVersionIds).toEqual([version.id]);
    const finished = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { status: 'finished' },
      }),
      200,
    );
    expect(finished.outputModelVersionIds).toEqual([version.id]);
    await services.runs.patch(fixture.editorPrincipal, fixture.project.id, {
      runId: run.id,
      input: { tags: { note: 'after' } },
    });
    expect(await finishedEventOutputModels(run.id)).toEqual([[version.id]]);
    expect(handler.outputs).toEqual([]);

    const second = await fixture.newRun('Training 2', 'training');
    const secondVersion = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { sourceRunId: second.id },
      }),
    );
    await services.runs.patch(fixture.editorPrincipal, fixture.project.id, {
      runId: second.id,
      input: { status: 'finished' },
    });
    expect(handler.outputs).toEqual([[secondVersion.id]]);
  });

  it('出力モデル版の登録中にMLflow UpdateRunで終端にすると、登録の確定を待ってから版入りで終端になる', async () => {
    const fixture = await setup();
    const handler = outputModelRecorder();
    const services = servicesWith([handler]);
    const created = await services.tracking.create(fixture.editorPrincipal, fixture.project.id, {
      experiment_id: fixture.experiment.id,
      tags: [],
    });
    const runId = created.info.run_id;
    const registration = await harness.database.connect();
    try {
      await registration.query('BEGIN');
      const version = await harness.services.registry.registerModelVersion(registration, {
        projectId: fixture.project.id,
        modelId: fixture.model.id,
        sourceRunId: runId,
        parentVersionIds: [],
        metadata: {},
        actor: { type: 'principal', principal: fixture.editorPrincipal },
      });
      const registrationPid = (
        await registration.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      let isFinished = false;
      const finishing = services.tracking
        .update(fixture.editorPrincipal, fixture.project.id, { runId, status: 'FINISHED' })
        .finally(() => {
          isFinished = true;
        });
      await vi.waitFor(async () => {
        const blocked = await harness.database.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [registrationPid],
        );
        expect(blocked.rows[0]!.count).toBe(1);
      });
      expect(isFinished).toBe(false);
      await registration.query('COMMIT');
      await finishing;
      expect(handler.outputs).toEqual([[version.id]]);
      // The registration saw a running Run, so only the terminal transition wrote run.finished.
      expect(await finishedEventOutputModels(runId)).toEqual([[version.id]]);
    } finally {
      await registration.query('ROLLBACK').catch(() => undefined);
      registration.release();
    }
  });
});
