import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ExperimentTask,
  Job,
  Model,
  ModelAutomationRule,
  ModelVersion,
  Run,
  RunOutputRegistration,
  TaskExecution,
  TaskOutputModel,
  WorkerJob,
} from '@mmt/contracts';
import { transaction } from '../src/db/database.js';
import { OutputRegistrationHandler } from '../src/services/outputRegistrationHandler.js';
import { uploadFixtureArtifact } from './containerFixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { workbenchFixture } from './workbenchFixtures.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const WEIGHTS_PATH = 'container/model/weights.bin';

describe.skipIf(!testDatabaseUrl)('Taskの成功時の出力モデル登録（独立PostgreSQL）', () => {
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

  async function saveOutputModel(
    fixture: Fixture,
    outputModel: Partial<TaskOutputModel> | null,
    expectedRevision = 1,
  ): Promise<ExperimentTask> {
    return entity<ExperimentTask>(
      await request(harness.app, fixture.taskPath, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: {
          expectedRevision,
          outputModel: outputModel && { artifactPath: WEIGHTS_PATH, ...outputModel },
        },
      }),
      200,
    );
  }

  async function launch(fixture: Fixture, revision: number): Promise<TaskExecution> {
    return entity<TaskExecution>(
      await request(harness.app, `${fixture.taskPath}/launch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: revision },
      }),
    );
  }

  async function registerInferenceRule(fixture: Fixture): Promise<ModelAutomationRule> {
    return entity<ModelAutomationRule>(
      await request(harness.app, `${fixture.basePath}/automation-rules`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Inference after training',
          modelFamilies: ['qwen2'],
          kind: 'inference',
          experimentId: fixture.experiment.id,
          codeVersionId: fixture.codeVersion.id,
          targetId: fixture.target.id,
        },
      }),
    );
  }

  async function claim(fixture: Fixture, runId: string): Promise<WorkerJob> {
    const claimed = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'output-registration-worker' },
      }),
      200,
    );
    expect(claimed.item?.run.id).toBe(runId);
    return claimed.item!;
  }

  async function complete(
    fixture: Fixture,
    claimed: WorkerJob,
    status: 'finished' | 'failed' | 'canceled' = 'finished',
  ): Promise<void> {
    await entity(
      await request(harness.app, `/api/worker/jobs/${claimed.job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: claimed.job.leaseId, status, exitCode: status === 'finished' ? 0 : 1 },
      }),
      200,
    );
  }

  // Launch → claim → upload weights → complete, as the worker does for a training Task.
  async function runTask(
    fixture: Fixture,
    options: {
      revision: number;
      status?: 'finished' | 'failed' | 'canceled';
      upload?: boolean;
      beforeComplete?: (run: Run) => Promise<void>;
    },
  ): Promise<Run> {
    const { run } = await launch(fixture, options.revision);
    const claimed = await claim(fixture, run.id);
    if (options.upload ?? true)
      await uploadFixtureArtifact(harness, fixture, { path: WEIGHTS_PATH, runId: run.id });
    await options.beforeComplete?.(run);
    await complete(fixture, claimed, options.status);
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  async function readRegistration(fixture: Fixture, runId: string): Promise<Response> {
    return request(harness.app, `${fixture.basePath}/runs/${runId}/output-registration`, {
      cookie: fixture.viewer.cookie,
    });
  }

  async function modelVersions(fixture: Fixture, modelId: string): Promise<ModelVersion[]> {
    return (
      await entity<{ items: ModelVersion[] }>(
        await request(harness.app, `${fixture.basePath}/models/${modelId}/versions`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      )
    ).items;
  }

  async function inferenceJobs(fixture: Fixture): Promise<Job[]> {
    const jobs = await entity<{ items: Job[] }>(
      await request(harness.app, `${fixture.basePath}/jobs`, { cookie: fixture.viewer.cookie }),
      200,
    );
    const runKinds = await harness.database.query<{ id: string; kind: string }>(
      'SELECT id,kind FROM runs',
    );
    const inferenceRunIds = new Set(
      runKinds.rows.filter((run) => run.kind === 'inference').map((run) => run.id),
    );
    return jobs.items.filter((job) => inferenceRunIds.has(job.runId));
  }

  it('成功したRunでバージョンを1件登録し、sourceRun・親バージョン・自動採番が入り、推論Jobがqueuedになる', async () => {
    const fixture = await workbenchFixture(harness);
    await registerInferenceRule(fixture);
    const task = await saveOutputModel(fixture, {
      modelId: fixture.model.id,
      defaultCodeVersionId: fixture.codeVersion.id,
      metadata: { purpose: 'fixture' },
    });
    expect(task.outputModel).toEqual({
      modelId: fixture.model.id,
      createModel: null,
      artifactPath: WEIGHTS_PATH,
      defaultCodeVersionId: fixture.codeVersion.id,
      metadata: { purpose: 'fixture' },
    });
    const run = await runTask(fixture, { revision: 2 });
    expect(run.status).toBe('finished');
    const registration = await entity<RunOutputRegistration>(
      await readRegistration(fixture, run.id),
      200,
    );
    expect(registration).toMatchObject({ status: 'registered', error: null, reason: null });
    const versions = (await modelVersions(fixture, fixture.model.id)).filter(
      (version) => version.sourceRunId === run.id,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: registration.modelVersionId,
      version: '1',
      parentModelVersionIds: [fixture.modelVersion.id],
      defaultCodeVersionId: fixture.codeVersion.id,
      metadata: { purpose: 'fixture' },
    });
    expect(run.outputModelVersionIds).toEqual([registration.modelVersionId]);
    const jobs = await inferenceJobs(fixture);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('queued');
  });

  it('createModelは初回にModelを作り、2回目は同じModelへ次のバージョンを足す', async () => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, {
      createModel: { name: 'Fine-tuned output', family: 'qwen2' },
    });
    const first = await runTask(fixture, { revision: 2 });
    const second = await runTask(fixture, { revision: 2 });
    const models = await entity<{ items: Model[] }>(
      await request(
        harness.app,
        `${fixture.basePath}/models?name=${encodeURIComponent('Fine-tuned output')}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(models.items).toHaveLength(1);
    const created = models.items[0]!;
    expect(created.family).toBe('qwen2');
    const versions = await modelVersions(fixture, created.id);
    expect(
      versions
        .map((version) => [version.sourceRunId, version.version])
        .sort((a, b) => a[1]!.localeCompare(b[1]!)),
    ).toEqual([
      [first.id, '1'],
      [second.id, '2'],
    ]);
  });

  it('versionTemplateはRunごとに描画したバージョン名で登録する', async () => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, {
      modelId: fixture.model.id,
      versionTemplate: 'task-r{taskRevision}-{runId}',
    });
    const run = await runTask(fixture, { revision: 2 });
    const registration = await entity<RunOutputRegistration>(
      await readRegistration(fixture, run.id),
      200,
    );
    const version = (await modelVersions(fixture, fixture.model.id)).find(
      (candidate) => candidate.id === registration.modelVersionId,
    );
    expect(version?.version).toBe(`task-r2-${run.id}`);
  });

  it('学習コードが同じModelへ登録済みならskippedでバージョンは1件、下流Jobも1件', async () => {
    const fixture = await workbenchFixture(harness);
    await registerInferenceRule(fixture);
    await saveOutputModel(fixture, { modelId: fixture.model.id });
    let sdkVersion: ModelVersion | undefined;
    const run = await runTask(fixture, {
      revision: 2,
      beforeComplete: async (running) => {
        const artifact = await uploadFixtureArtifact(harness, fixture, {
          path: 'sdk/weights.bin',
          runId: running.id,
        });
        sdkVersion = await entity<ModelVersion>(
          await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { sourceRunId: running.id, artifactId: artifact.id },
          }),
        );
      },
    });
    expect(
      await entity<RunOutputRegistration>(await readRegistration(fixture, run.id), 200),
    ).toEqual({
      status: 'skipped',
      modelVersionId: sdkVersion!.id,
      error: null,
      reason: 'already_registered_by_run',
    });
    expect(
      (await modelVersions(fixture, fixture.model.id)).filter(
        (version) => version.sourceRunId === run.id,
      ),
    ).toHaveLength(1);
    expect(await inferenceJobs(fixture)).toHaveLength(1);
  });

  it('学習コードが別のModelへ登録していてもTask側の登録は行う', async () => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, { modelId: fixture.model.id });
    const other = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Other output', family: 'qwen2' },
      }),
    );
    const run = await runTask(fixture, {
      revision: 2,
      beforeComplete: async (running) => {
        await entity(
          await request(harness.app, `${fixture.basePath}/models/${other.id}/versions`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { sourceRunId: running.id, weightsUri: 'https://weights.example.test/a.bin' },
          }),
        );
      },
    });
    const registration = await entity<RunOutputRegistration>(
      await readRegistration(fixture, run.id),
      200,
    );
    expect(registration.status).toBe('registered');
    expect(run.outputModelVersionIds).toHaveLength(2);
  });

  it.each(['failed', 'canceled'] as const)('%sのRunでは登録せず記録も残さない', async (status) => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, { modelId: fixture.model.id });
    const run = await runTask(fixture, { revision: 2, status });
    expect(run.status).toBe(status);
    const response = await readRegistration(fixture, run.id);
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('output_registration_not_found');
    expect(run.outputModelVersionIds).toEqual([]);
  });

  it('Artifactが無ければfailedを記録し、Runはfinishedのまま、バージョンもJobも作らない', async () => {
    const fixture = await workbenchFixture(harness);
    await registerInferenceRule(fixture);
    await saveOutputModel(fixture, { createModel: { name: 'Never created', family: 'qwen2' } });
    const run = await runTask(fixture, { revision: 2, upload: false });
    expect(run.status).toBe('finished');
    expect(
      await entity<RunOutputRegistration>(await readRegistration(fixture, run.id), 200),
    ).toEqual({
      status: 'failed',
      modelVersionId: null,
      error: 'artifact_not_found',
      reason: null,
    });
    // The savepoint also rolls back the Model created for this attempt.
    expect(
      (await harness.database.query("SELECT id FROM models WHERE name='Never created'")).rows,
    ).toEqual([]);
    expect(await inferenceJobs(fixture)).toEqual([]);
  });

  it('Runの作成者が編集権限を失っていればfailed(creator_access_revoked)になる', async () => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, { modelId: fixture.model.id });
    const run = await runTask(fixture, {
      revision: 2,
      beforeComplete: async () => {
        await harness.database.query(
          "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
          [fixture.project.id, fixture.editor.userId],
        );
      },
    });
    expect(
      await entity<RunOutputRegistration>(await readRegistration(fixture, run.id), 200),
    ).toMatchObject({ status: 'failed', error: 'creator_access_revoked' });
  });

  it('Run作成後にTaskを編集しても、Runに複写した設定とretryの設定は変わらない', async () => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, { modelId: fixture.model.id });
    const { run, job } = await launch(fixture, 2);
    expect(run.outputModelRegistration).toMatchObject({ modelId: fixture.model.id });
    await saveOutputModel(fixture, null, 2);
    const claimed = await claim(fixture, run.id);
    await complete(fixture, claimed, 'failed');
    const retried = await entity<{ run: Run }>(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/retry`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
    );
    expect(retried.run.outputModelRegistration).toEqual(run.outputModelRegistration);
    const relaunched = await launch(fixture, 3);
    expect(relaunched.run.outputModelRegistration).toBeNull();
    await expect(
      harness.database.query('UPDATE runs SET output_model_registration=NULL WHERE id=$1', [
        run.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('テスト実行のRunには出力設定を複写しない', async () => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, { modelId: fixture.model.id });
    const execution = await entity<TaskExecution>(
      await request(harness.app, `${fixture.taskPath}/launch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: 2, executionMode: 'test' },
      }),
    );
    expect(execution.run.outputModelRegistration).toBeNull();
  });

  it('同じRunの2回目の終端（MLflowの再開後など）では登録し直さない', async () => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, { modelId: fixture.model.id });
    const run = await runTask(fixture, { revision: 2 });
    const handler = new OutputRegistrationHandler({
      registerModelVersion: () => {
        throw new Error('must not register twice');
      },
    });
    await transaction(harness.database, (connection) =>
      handler.handle(connection, { previousStatus: 'running', run }),
    );
    expect(
      (await modelVersions(fixture, fixture.model.id)).filter(
        (version) => version.sourceRunId === run.id,
      ),
    ).toHaveLength(1);
  });

  it('viewerは記録を読め、Projectに属さない利用者は読めない', async () => {
    const fixture = await workbenchFixture(harness);
    await saveOutputModel(fixture, { modelId: fixture.model.id });
    const run = await runTask(fixture, { revision: 2 });
    expect((await readRegistration(fixture, run.id)).status).toBe(200);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/runs/${run.id}/output-registration`, {
          cookie: fixture.outsider.cookie,
        })
      ).status,
    ).toBe(403);
  });
});
