import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Dataset,
  DatasetVersion,
  ExperimentTask,
  Job,
  Model,
  ModelAutomationExecution,
  ModelVersion,
  Run,
  RunOutputRegistration,
  TaskExecution,
  WorkerJob,
  WorkerOutputDeclaration,
  WorkerOutputsResponse,
} from '@mmt/contracts';
import { transaction } from '../src/db/database.js';
import { registerDatasetVersion } from '../src/services/datasetVersionRegistration.js';
import { uploadFixtureArtifact } from './containerFixtures.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { workbenchFixture } from './workbenchFixtures.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const WEIGHTS_OUTPUT = 'model/weights.bin';
const SPLIT_OUTPUT = 'data/test.jsonl';

describe.skipIf(!testDatabaseUrl)('workerによる出力の宣言と登録（独立PostgreSQL）', () => {
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

  async function outputWorkerToken(fixture: Fixture, scopes: string[]): Promise<string> {
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Output worker',
          kind: 'service',
          projectId: fixture.project.id,
          scopes,
        },
      }),
    );
    return minted.token;
  }

  async function setup(options: { scopes?: string[] } = {}) {
    const fixture = await workbenchFixture(harness);
    const token = await outputWorkerToken(
      fixture,
      options.scopes ?? ['worker:execute', 'registry:write'],
    );
    return { fixture, token };
  }

  async function claim(token: string, runId: string): Promise<WorkerJob> {
    const claimed = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token,
        body: { workerId: 'output-worker' },
      }),
      200,
    );
    expect(claimed.item?.run.id).toBe(runId);
    return claimed.item!;
  }

  async function launchTraining(fixture: Fixture, token: string, revision = 1) {
    const execution = await entity<TaskExecution>(
      await request(harness.app, `${fixture.taskPath}/launch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: revision },
      }),
    );
    return claim(token, execution.run.id);
  }

  async function uploadOutput(fixture: Fixture, claimed: WorkerJob, outputPath: string) {
    return uploadFixtureArtifact(harness, fixture, {
      path: `container/${outputPath}`,
      runId: claimed.run.id,
    });
  }

  function declare(
    token: string,
    claimed: WorkerJob,
    declarations: WorkerOutputDeclaration[],
    leaseId = claimed.job.leaseId,
  ): Promise<Response> {
    return request(harness.app, `/api/worker/jobs/${claimed.job.id}/outputs`, {
      method: 'POST',
      token,
      body: { leaseId, declarations },
    });
  }

  async function complete(
    token: string,
    claimed: WorkerJob,
    status: 'finished' | 'failed' = 'finished',
  ): Promise<void> {
    await entity(
      await request(harness.app, `/api/worker/jobs/${claimed.job.id}/complete`, {
        method: 'POST',
        token,
        body: {
          leaseId: claimed.job.leaseId,
          status,
          exitCode: status === 'finished' ? 0 : 1,
        },
      }),
      200,
    );
  }

  async function errorCode(response: Response, status: number): Promise<string> {
    expect(response.status).toBe(status);
    return ((await response.json()) as { code: string }).code;
  }

  async function runVersions(fixture: Fixture, modelId: string, runId: string) {
    const versions = await entity<{ items: ModelVersion[] }>(
      await request(harness.app, `${fixture.basePath}/models/${modelId}/versions`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    return versions.items.filter((version) => version.sourceRunId === runId);
  }

  async function createModel(fixture: Fixture, name: string): Promise<Model> {
    return entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name, family: 'qwen2' },
      }),
    );
  }

  async function createDataset(basePath: string, cookie: string, name: string): Promise<Dataset> {
    return entity<Dataset>(
      await request(harness.app, `${basePath}/datasets`, {
        method: 'POST',
        cookie,
        body: { name, namespace: 'outputs' },
      }),
    );
  }

  async function registerInferenceRule(fixture: Fixture): Promise<void> {
    await entity(
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

  async function automationExecutions(fixture: Fixture): Promise<ModelAutomationExecution[]> {
    return (
      await entity<{ items: ModelAutomationExecution[] }>(
        await request(harness.app, `${fixture.basePath}/automation-executions`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      )
    ).items;
  }

  async function inferenceJobs(fixture: Fixture): Promise<Job[]> {
    const result = await harness.database.query<{ id: string }>(
      "SELECT j.id FROM jobs j JOIN runs r ON r.id=j.run_id WHERE r.project_id=$1 AND r.kind='inference'",
      [fixture.project.id],
    );
    return result.rows as unknown as Job[];
  }

  async function saveTaskOutputModel(fixture: Fixture, modelId: string): Promise<void> {
    await entity<ExperimentTask>(
      await request(harness.app, fixture.taskPath, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: {
          expectedRevision: 1,
          outputModel: {
            modelId,
            artifactPath: `container/${WEIGHTS_OUTPUT}`,
          },
        },
      }),
      200,
    );
  }

  it('宣言したモデルとデータセットを版として登録し、sourceRun・親版・URIが入る', async () => {
    const { fixture, token } = await setup();
    const dataset = await createDataset(fixture.basePath, fixture.editor.cookie, 'Test split');
    const claimed = await launchTraining(fixture, token);
    const weights = await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    await uploadOutput(fixture, claimed, SPLIT_OUTPUT);
    const response = await entity<WorkerOutputsResponse>(
      await declare(token, claimed, [
        {
          index: 0,
          kind: 'model',
          path: WEIGHTS_OUTPUT,
          modelId: fixture.model.id,
          metadata: { epoch: 2 },
        },
        {
          index: 1,
          kind: 'dataset',
          datasetId: dataset.id,
          path: SPLIT_OUTPUT,
          digest: 'sha256:split',
        },
        {
          index: 2,
          kind: 'dataset',
          datasetId: dataset.id,
          uri: 's3://bucket/eval/',
          digest: 'external',
        },
      ]),
      200,
    );
    expect(response.items.map((item) => [item.index, item.kind])).toEqual([
      [0, 'model'],
      [1, 'dataset'],
      [2, 'dataset'],
    ]);
    const [modelVersion] = await runVersions(fixture, fixture.model.id, claimed.run.id);
    expect(modelVersion).toMatchObject({
      id: response.items[0]!.modelVersionId,
      version: '1',
      artifactId: weights.id,
      parentModelVersionIds: [fixture.modelVersion.id],
      metadata: { epoch: 2 },
    });
    const datasetVersions = await entity<{ items: DatasetVersion[] }>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(
      datasetVersions.items
        .map((version) => [version.version, version.uri, version.sourceRunId])
        .sort(),
    ).toEqual([
      ['1', `mmt-artifact://runs/${claimed.run.id}/container/${SPLIT_OUTPUT}`, claimed.run.id],
      ['2', 's3://bucket/eval/', claimed.run.id],
    ]);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${claimed.run.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(run.outputModelVersionIds).toEqual([modelVersion!.id]);
    expect(new Set(run.outputDatasetVersionIds)).toEqual(
      new Set([response.items[1]!.datasetVersionId, response.items[2]!.datasetVersionId]),
    );
  });

  it('同じindexの再送は保存済みの結果を返し、二重登録しない', async () => {
    const { fixture, token } = await setup();
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    const declaration: WorkerOutputDeclaration = {
      index: 0,
      kind: 'model',
      path: WEIGHTS_OUTPUT,
      modelId: fixture.model.id,
    };
    const first = await entity<WorkerOutputsResponse>(
      await declare(token, claimed, [declaration]),
      200,
    );
    const second = await entity<WorkerOutputsResponse>(
      await declare(token, claimed, [declaration]),
      200,
    );
    expect(second).toEqual(first);
    expect(await runVersions(fixture, fixture.model.id, claimed.run.id)).toHaveLength(1);
    // A resend after completion (the response was lost) still answers from the stored rows.
    await complete(token, claimed);
    expect(
      await entity<WorkerOutputsResponse>(await declare(token, claimed, [declaration]), 200),
    ).toEqual(first);
    expect(
      await errorCode(await declare(token, claimed, [{ ...declaration, index: 1 }]), 409),
    ).toBe('conflict');
    expect(
      await errorCode(
        await declare(token, claimed, [
          {
            index: 0,
            kind: 'dataset',
            datasetId: fixture.model.id,
            uri: 's3://x',
            digest: 'd',
          },
        ]),
        409,
      ),
    ).toBe('output_declaration_mismatch');
  });

  it('古いleaseやregistry:writeの無いworker tokenは拒否する', async () => {
    const { fixture, token } = await setup({ scopes: ['worker:execute'] });
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    const declaration: WorkerOutputDeclaration = {
      index: 0,
      kind: 'model',
      path: WEIGHTS_OUTPUT,
      modelId: fixture.model.id,
    };
    expect(
      await errorCode(await declare(token, claimed, [declaration], crypto.randomUUID()), 409),
    ).toBe('invalid_lease');
    expect(await errorCode(await declare(token, claimed, [declaration]), 403)).toBe(
      'insufficient_scope',
    );
    expect(await runVersions(fixture, fixture.model.id, claimed.run.id)).toEqual([]);
  });

  it('inference Runのモデル宣言は422で、データセット宣言は受け付ける', async () => {
    const { fixture, token } = await setup();
    const run = await fixture.newRun('Inference', 'inference');
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id },
      }),
    );
    const claimed = await claim(token, run.id);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    expect(
      await errorCode(
        await declare(token, claimed, [
          {
            index: 0,
            kind: 'model',
            path: WEIGHTS_OUTPUT,
            modelId: fixture.model.id,
          },
        ]),
        422,
      ),
    ).toBe('output_model_kind');
    const dataset = await createDataset(fixture.basePath, fixture.editor.cookie, 'Predictions');
    await entity(
      await declare(token, claimed, [
        {
          index: 1,
          kind: 'dataset',
          datasetId: dataset.id,
          path: WEIGHTS_OUTPUT,
          digest: 'd',
        },
      ]),
      200,
    );
  });

  it('別Projectのモデル・データセットは404、未保存のpathは422で、何も登録しない', async () => {
    const { fixture, token } = await setup();
    const other = await projectFixture(harness);
    const otherModel = await entity<Model>(
      await request(harness.app, `${other.basePath}/models`, {
        method: 'POST',
        cookie: other.administrator.cookie,
        body: { name: 'Other project model', family: 'qwen2' },
      }),
    );
    const otherDataset = await createDataset(other.basePath, other.administrator.cookie, 'Other');
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    const valid: WorkerOutputDeclaration = {
      index: 0,
      kind: 'model',
      path: WEIGHTS_OUTPUT,
      modelId: fixture.model.id,
    };
    expect(
      await errorCode(
        await declare(token, claimed, [
          valid,
          {
            index: 1,
            kind: 'model',
            path: WEIGHTS_OUTPUT,
            modelId: otherModel.id,
          },
        ]),
        404,
      ),
    ).toBe('not_found');
    expect(
      await errorCode(
        await declare(token, claimed, [
          {
            index: 1,
            kind: 'dataset',
            datasetId: otherDataset.id,
            uri: 's3://x',
            digest: 'd',
          },
        ]),
        404,
      ),
    ).toBe('not_found');
    expect(
      await errorCode(
        await declare(token, claimed, [{ ...valid, path: 'model/missing.bin' }]),
        422,
      ),
    ).toBe('output_artifact_not_found');
    // A file uploaded outside container/ is not an output of this Job.
    await uploadFixtureArtifact(harness, fixture, {
      path: 'elsewhere.bin',
      runId: claimed.run.id,
    });
    expect(
      await errorCode(await declare(token, claimed, [{ ...valid, path: 'elsewhere.bin' }]), 422),
    ).toBe('output_artifact_not_found');
    expect(
      await errorCode(await declare(token, claimed, [{ ...valid, path: '../escape.bin' }]), 422),
    ).toBe('invalid_request');
    // The request is one transaction: the valid declaration above was rolled back as well.
    expect(await runVersions(fixture, fixture.model.id, claimed.run.id)).toEqual([]);
    expect((await harness.database.query('SELECT 1 FROM run_output_declarations')).rows).toEqual(
      [],
    );
  });

  it('モデルの宣言はRunごとに16件までで、分けて送っても超えられない', async () => {
    const { fixture, token } = await setup();
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    const models = (indexes: number[]): WorkerOutputDeclaration[] =>
      indexes.map((index) => ({
        index,
        kind: 'model',
        path: WEIGHTS_OUTPUT,
        modelId: fixture.model.id,
      }));
    const seventeen = Array.from({ length: 17 }, (_, index) => index);
    expect(await errorCode(await declare(token, claimed, models(seventeen)), 422)).toBe(
      'output_declaration_limit',
    );
    await entity(await declare(token, claimed, models(seventeen.slice(0, 16))), 200);
    expect(await errorCode(await declare(token, claimed, models([16])), 422)).toBe(
      'output_declaration_limit',
    );
    expect(await runVersions(fixture, fixture.model.id, claimed.run.id)).toHaveLength(16);
  });

  it('Taskの出力モデルと同じModelへの宣言は登録され、Task側はskippedで下流Jobは1件', async () => {
    const { fixture, token } = await setup();
    await registerInferenceRule(fixture);
    await saveTaskOutputModel(fixture, fixture.model.id);
    const claimed = await launchTraining(fixture, token, 2);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    // Without modelId the declaration goes to the Task's output model.
    const declared = await entity<WorkerOutputsResponse>(
      await declare(token, claimed, [{ index: 0, kind: 'model', path: WEIGHTS_OUTPUT }]),
      200,
    );
    expect(await inferenceJobs(fixture)).toEqual([]);
    await complete(token, claimed);
    const registration = await entity<RunOutputRegistration>(
      await request(harness.app, `${fixture.basePath}/runs/${claimed.run.id}/output-registration`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(registration).toEqual({
      status: 'skipped',
      modelVersionId: declared.items[0]!.modelVersionId,
      error: null,
      reason: 'already_registered_by_run',
    });
    expect(await runVersions(fixture, fixture.model.id, claimed.run.id)).toHaveLength(1);
    expect(await inferenceJobs(fixture)).toHaveLength(1);
  });

  it('Taskの出力モデルと別のModelを指す宣言は422', async () => {
    const { fixture, token } = await setup();
    await saveTaskOutputModel(fixture, fixture.model.id);
    const other = await createModel(fixture, 'Other output');
    const claimed = await launchTraining(fixture, token, 2);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    expect(
      await errorCode(
        await declare(token, claimed, [
          {
            index: 0,
            kind: 'model',
            path: WEIGHTS_OUTPUT,
            modelId: other.id,
          },
        ]),
        422,
      ),
    ).toBe('output_model_conflict');
    expect(await runVersions(fixture, other.id, claimed.run.id)).toEqual([]);
  });

  it('Taskの設定が無くmodelIdも無い宣言は422', async () => {
    const { fixture, token } = await setup();
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    expect(
      await errorCode(
        await declare(token, claimed, [{ index: 0, kind: 'model', path: WEIGHTS_OUTPUT }]),
        422,
      ),
    ).toBe('output_model_required');
  });

  it('宣言したモデルの下流は学習Runの成功後に1件だけ起動する', async () => {
    const { fixture, token } = await setup();
    await registerInferenceRule(fixture);
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    await entity(
      await declare(token, claimed, [
        {
          index: 0,
          kind: 'model',
          path: WEIGHTS_OUTPUT,
          modelId: fixture.model.id,
        },
      ]),
      200,
    );
    const pending = await automationExecutions(fixture);
    expect(pending.map((execution) => execution.status)).toEqual(['pending']);
    expect(await inferenceJobs(fixture)).toEqual([]);
    await complete(token, claimed);
    const executions = await automationExecutions(fixture);
    expect(executions.map((execution) => execution.status)).toEqual(['queued']);
    expect(await inferenceJobs(fixture)).toHaveLength(1);
  });

  it('failedで終わったRunの宣言モデルの下流はskippedになる', async () => {
    const { fixture, token } = await setup();
    await registerInferenceRule(fixture);
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    await entity(
      await declare(token, claimed, [
        {
          index: 0,
          kind: 'model',
          path: WEIGHTS_OUTPUT,
          modelId: fixture.model.id,
        },
      ]),
      200,
    );
    await complete(token, claimed, 'failed');
    const executions = await automationExecutions(fixture);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ status: 'skipped' });
    expect(executions[0]!.error).toMatch(/^source_run_unsuccessful/);
    expect(await inferenceJobs(fixture)).toEqual([]);
  });

  it('Runの作成者が編集権限を失っていれば403で登録しない', async () => {
    const { fixture, token } = await setup();
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    await harness.database.query(
      "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [fixture.project.id, fixture.editor.userId],
    );
    expect(
      await errorCode(
        await declare(token, claimed, [
          {
            index: 0,
            kind: 'model',
            path: WEIGHTS_OUTPUT,
            modelId: fixture.model.id,
          },
        ]),
        403,
      ),
    ).toBe('project_forbidden');
  });

  it('Publicで入っているだけのRunの作成者も、宣言したデータセットとモデルを登録できる', async () => {
    const { fixture, token } = await setup();
    const dataset = await createDataset(fixture.basePath, fixture.editor.cookie, 'Public split');
    const claimed = await launchTraining(fixture, token);
    await uploadOutput(fixture, claimed, WEIGHTS_OUTPUT);
    await uploadOutput(fixture, claimed, SPLIT_OUTPUT);
    // The creator keeps the editor role only through the Project's public visibility.
    await harness.database.query("UPDATE projects SET visibility='public' WHERE id=$1", [
      fixture.project.id,
    ]);
    await harness.database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [
      fixture.project.id,
      fixture.editor.userId,
    ]);
    const response = await entity<WorkerOutputsResponse>(
      await declare(token, claimed, [
        { index: 0, kind: 'model', path: WEIGHTS_OUTPUT, modelId: fixture.model.id },
        { index: 1, kind: 'dataset', datasetId: dataset.id, path: SPLIT_OUTPUT, digest: 'sha256:split' },
      ]),
      200,
    );
    expect(response.items.map((item) => [item.index, item.kind])).toEqual([
      [0, 'model'],
      [1, 'dataset'],
    ]);
  });

  it('registerDatasetVersionはprincipalの権限を確かめ、明示した版名は採番に数えない', async () => {
    const { fixture } = await setup();
    const dataset = await createDataset(fixture.basePath, fixture.editor.cookie, 'Direct');
    const principalOf = async (cookie: string) =>
      (await harness.services.auth.authenticate({
        session: cookie.slice(cookie.indexOf('=') + 1),
      }))!;
    const register = async (cookie: string, version?: string) =>
      transaction(harness.database, async (connection) =>
        registerDatasetVersion(connection, {
          projectId: fixture.project.id,
          datasetId: dataset.id,
          version,
          uri: 's3://bucket/direct/',
          digest: 'digest',
          schema: {},
          metadata: {},
          parentDatasetVersionIds: [],
          actor: {
            type: 'principal',
            principal: await principalOf(cookie),
          },
        }),
      );
    await expect(register(fixture.viewer.cookie)).rejects.toMatchObject({
      code: 'project_forbidden',
    });
    expect((await register(fixture.editor.cookie, 'v-named')).version).toBe('v-named');
    expect((await register(fixture.editor.cookie)).version).toBe('1');
    expect((await register(fixture.editor.cookie)).version).toBe('2');
  });
});
