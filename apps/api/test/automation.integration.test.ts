import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  Experiment,
  Job,
  ModelAutomationExecution,
  ModelAutomationRule,
  ModelVersion,
  Project,
  Run,
  WorkerJob,
} from '@mmt/contracts';
import { transaction } from '../src/db/database.js';
import { DomainError } from '../src/domain/errors.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import {
  automationRuleInput,
  containerCodeInput,
  containerFixture,
  uploadFixtureArtifact,
  type ContainerFixture,
} from './containerFixtures.js';

describe.skipIf(!testDatabaseUrl)('モデル登録後の自動推論・評価（独立PostgreSQL）', () => {
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

  async function registerRule(
    fixture: ContainerFixture,
    options: {
      overrides?: Record<string, unknown>;
      cookie?: string;
      token?: string;
    } = {},
  ): Promise<ModelAutomationRule> {
    return entity<ModelAutomationRule>(
      await request(harness.app, `${fixture.basePath}/automation-rules`, {
        method: 'POST',
        cookie: options.cookie ?? fixture.administrator.cookie,
        token: options.token,
        body: automationRuleInput(fixture, options.overrides),
      }),
    );
  }

  async function registerModel(
    fixture: ContainerFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<ModelVersion> {
    return entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'weights-v1',
          weightsUri: 'https://weights.example.test/weights.bin',
          ...overrides,
        },
      }),
    );
  }

  async function executionHistory(fixture: ContainerFixture): Promise<ModelAutomationExecution[]> {
    return (
      await entity<{ items: ModelAutomationExecution[] }>(
        await request(harness.app, `${fixture.basePath}/automation-executions`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      )
    ).items;
  }

  async function replayRegistration(fixture: ContainerFixture, model: ModelVersion): Promise<void> {
    await transaction(harness.database, (connection) =>
      harness.services.automation.processRegistration(connection, {
        projectId: fixture.project.id,
        modelVersionId: model.id,
      }),
    );
  }

  it('Project adminとglobal adminだけがルールを変更でき、viewer/readは一覧を読める', async () => {
    const fixture = await containerFixture(harness);
    for (const identity of [fixture.editor, fixture.viewer, fixture.outsider]) {
      expect(
        (
          await request(harness.app, `${fixture.basePath}/automation-rules`, {
            method: 'POST',
            cookie: identity.cookie,
            body: automationRuleInput(fixture),
          })
        ).status,
      ).toBe(403);
    }
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'admin' },
      }),
      200,
    );
    const rule = await registerRule(fixture, {
      cookie: fixture.editor.cookie,
    });
    expect(rule.createdBy).toBe(fixture.editor.userId);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/automation-rules/${rule.id}`, {
          method: 'PATCH',
          cookie: fixture.viewer.cookie,
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
    const disabled = await entity<ModelAutomationRule>(
      await request(harness.app, `${fixture.basePath}/automation-rules/${rule.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { enabled: false },
      }),
      200,
    );
    expect(disabled.enabled).toBe(false);
    const list = await entity<{ items: ModelAutomationRule[] }>(
      await request(harness.app, `${fixture.basePath}/automation-rules`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(list.items).toHaveLength(1);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/automation-executions`, {
          cookie: fixture.outsider.cookie,
        })
      ).status,
    ).toBe(403);
    expect((await request(harness.app, `${fixture.basePath}/automation-rules`)).status).toBe(401);
    // A global admin remains authorized even with an explicit lower project role.
    await harness.database.query(
      "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [fixture.project.id, fixture.administrator.userId],
    );
    const globalRule = await registerRule(fixture, {
      overrides: { name: 'Global admin rule' },
    });
    expect(globalRule.createdBy).toBe(fixture.administrator.userId);
  });

  it('ルール変更にはadmin scopeと現在のProject accessを両方要求する', async () => {
    const fixture = await containerFixture(harness);
    const mint = async (scopes: string[], cookie: string) =>
      entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie,
          body: {
            name: 'Scoped rule token',
            kind: 'personal',
            projectId: fixture.project.id,
            scopes,
          },
        }),
      );
    const insufficient = await mint(['registry:write', 'jobs:write'], fixture.administrator.cookie);
    const endpoint = `${fixture.basePath}/automation-rules`;
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'POST',
          token: insufficient.token,
          body: automationRuleInput(fixture),
        })
      ).status,
    ).toBe(403);
    expect((await request(harness.app, endpoint, { token: insufficient.token })).status).toBe(403);
    const administrative = await mint(['admin'], fixture.administrator.cookie);
    const rule = await registerRule(fixture, { token: administrative.token });
    await harness.database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [
      fixture.project.id,
      fixture.administrator.userId,
    ]);
    expect(
      (
        await request(harness.app, `${endpoint}/${rule.id}`, {
          method: 'PATCH',
          token: administrative.token,
          body: { enabled: false },
        })
      ).status,
    ).toBe(401);
    const readToken = await mint(['read'], fixture.viewer.cookie);
    expect((await request(harness.app, endpoint, { token: readToken.token })).status).toBe(200);
  });

  it('設定は不変で、PATCHはenabledのみを受け付ける', async () => {
    const fixture = await containerFixture(harness);
    const rule = await registerRule(fixture);
    for (const change of [
      { name: 'Changed' },
      { codeVersionId: fixture.codeVersion.id, enabled: false },
      {},
    ]) {
      expect(
        (
          await request(harness.app, `${fixture.basePath}/automation-rules/${rule.id}`, {
            method: 'PATCH',
            cookie: fixture.administrator.cookie,
            body: change,
          })
        ).status,
      ).toBe(422);
    }
    await expect(
      harness.database.query('UPDATE model_automation_rules SET parameters=$2 WHERE id=$1', [
        rule.id,
        '{"changed":true}',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const toggled = await entity<ModelAutomationRule>(
      await request(harness.app, `${fixture.basePath}/automation-rules/${rule.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: false },
      }),
      200,
    );
    expect({ ...toggled, enabled: rule.enabled }).toEqual(rule);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/automation-rules/${randomUUID()}`, {
          method: 'PATCH',
          cookie: fixture.administrator.cookie,
          body: { enabled: false },
        })
      ).status,
    ).toBe(404);
  });

  it.each([
    ['training', { kind: 'training' }],
    ['未対応family', { modelFamilies: ['qwen3'] }],
    ['空のfamilies', { modelFamilies: [] }],
    ['重複families', { modelFamilies: ['qwen2', 'qwen2'] }],
    ['存在しないGPU', { gpuIds: ['9'] }],
    ['重複GPU', { gpuIds: ['0', '0'] }],
    ['maxAttempts範囲外', { maxAttempts: 101 }],
    ['未知の設定', { environment: {} }],
  ])('%sのルールを保存前に拒否する', async (_name, overrides) => {
    const fixture = await containerFixture(harness);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/automation-rules`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: automationRuleInput(fixture, overrides),
        })
      ).status,
    ).toBe(422);
    expect(
      (await harness.database.query('SELECT * FROM model_automation_rules')).rows,
    ).toHaveLength(0);
  });

  it('CodeVersionのkindとruntime、enabled targetを作成時に検証する', async () => {
    const fixture = await containerFixture(harness);
    const endpoint = `${fixture.basePath}/automation-rules`;
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: automationRuleInput(fixture, {
            kind: 'evaluation',
            codeVersionId: fixture.codeVersion.id,
          }),
        })
      ).status,
    ).toBe(422);
    await harness.database.query('UPDATE compute_targets SET runtime_kinds=$2 WHERE id=$1', [
      fixture.target.id,
      ['python'],
    ]);
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: automationRuleInput(fixture),
        })
      ).status,
    ).toBe(422);
    await harness.database.query('UPDATE compute_targets SET enabled=false WHERE id=$1', [
      fixture.target.id,
    ]);
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: automationRuleInput(fixture, {
            codeVersionId: fixture.codeVersion.id,
          }),
        })
      ).status,
    ).toBe(404);
  });

  it('別ProjectのCodeVersion・Experiment・入力DatasetVersionをルールから参照できない', async () => {
    const fixture = await containerFixture(harness);
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherPath = `/api/projects/${other.id}`;
    const create = (path: string, body: object) =>
      request(harness.app, `${otherPath}/${path}`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body,
      });
    const experiment = await entity<Experiment>(
      await create('experiments', { name: 'Other experiment' }),
    );
    const code = await entity<Code>(await create('codes', { name: 'Other code' }));
    const codeVersion = await entity<CodeVersion>(
      await create(`codes/${code.id}/versions`, containerCodeInput()),
    );
    const dataset = await entity<Dataset>(await create('datasets', { name: 'Other inputs' }));
    const datasetVersion = await entity<DatasetVersion>(
      await create(`datasets/${dataset.id}/versions`, {
        version: 'v1',
        uri: 'file:///fixture/other',
        digest: 'fixture',
      }),
    );
    for (const reference of [
      { experimentId: experiment.id },
      { codeVersionId: codeVersion.id },
      { inputDatasetVersionIds: [datasetVersion.id] },
    ]) {
      expect(
        (
          await request(harness.app, `${fixture.basePath}/automation-rules`, {
            method: 'POST',
            cookie: fixture.administrator.cookie,
            body: automationRuleInput(fixture, reference),
          })
        ).status,
      ).toBe(404);
    }
    const rule = await registerRule(fixture);
    expect(
      (
        await request(harness.app, `${otherPath}/automation-rules/${rule.id}`, {
          method: 'PATCH',
          cookie: fixture.administrator.cookie,
          body: { enabled: false },
        })
      ).status,
    ).toBe(404);
    const scoped = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Other scoped token',
          kind: 'service',
          projectId: other.id,
          scopes: ['admin'],
        },
      }),
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/automation-rules`, {
          method: 'POST',
          token: scoped.token,
          body: automationRuleInput(fixture),
        })
      ).status,
    ).toBe(403);
  });

  it('モデル登録で設定を固定した推論と評価を作り、enqueue結果と実行状態を区別する', async () => {
    const fixture = await containerFixture(harness);
    const sourceRun = await fixture.newRun('Training output source', 'training');
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Evaluation inputs' },
      }),
    );
    const input = await entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v1',
          uri: 'file:///fixture/inputs',
          digest: 'fixture',
        },
      }),
    );
    const inference = await registerRule(fixture, {
      overrides: {
        gpuIds: ['0'],
        inputDatasetVersionIds: [input.id],
        parameters: { temperature: 0.2 },
        tags: { purpose: 'inference' },
        maxAttempts: 4,
      },
    });
    const evaluation = await registerRule(fixture, {
      overrides: {
        name: 'Automatic evaluation',
        kind: 'evaluation',
        gpuIds: ['1'],
      },
    });
    const newerCode = await entity<CodeVersion>(
      await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: containerCodeInput({
          version: 'container-v2',
          runtime: {
            kind: 'docker',
            image: `example.test/newer@sha256:${'b'.repeat(64)}`,
          },
        }),
      }),
    );
    const model = await registerModel(fixture, {
      sourceRunId: sourceRun.id,
      defaultCodeVersionId: newerCode.id,
    });
    const history = await executionHistory(fixture);
    expect(history).toHaveLength(2);
    const automatic = history.find((execution) => execution.ruleId === inference.id)!;
    const evaluated = history.find((execution) => execution.ruleId === evaluation.id)!;
    expect(automatic).toMatchObject({
      projectId: fixture.project.id,
      modelVersionId: model.id,
      status: 'queued',
      runStatus: 'queued',
      jobStatus: 'queued',
      error: null,
    });
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${automatic.runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(run).toMatchObject({
      codeVersionId: fixture.containerCodeVersion.id,
      modelVersionId: model.id,
      kind: 'inference',
      parentRunId: sourceRun.id,
      createdBy: fixture.administrator.userId,
      parameters: inference.parameters,
      inputDatasetVersionIds: [input.id],
      tags: { purpose: 'inference', 'automation.ruleId': inference.id },
      environment: {
        automationRuleId: inference.id,
        runtime: fixture.containerCodeVersion.runtime,
      },
    });
    const jobs = await entity<{ items: Job[] }>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(jobs.items.find((job) => job.id === automatic.jobId)).toMatchObject({
      runId: automatic.runId,
      maxAttempts: 4,
      gpuIds: ['0'],
      targetId: fixture.target.id,
    });
    const evaluationRun = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${evaluated.runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(evaluationRun.kind).toBe('evaluation');
    const claimed = await entity<{ item: WorkerJob }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'automation-worker' },
      }),
      200,
    );
    const queuedHistory = await executionHistory(fixture);
    expect(
      queuedHistory.find((execution) => execution.jobId === claimed.item.job.id),
    ).toMatchObject({
      status: 'queued',
      runStatus: 'running',
      jobStatus: 'claimed',
    });
  });

  it('単なるArtifact uploadでは起動せず、保存済みweightsのModelVersion登録で起動する', async () => {
    const fixture = await containerFixture(harness);
    await registerRule(fixture);
    const artifact = await uploadFixtureArtifact(harness, fixture, {
      path: 'model/weights.bin',
    });
    expect(await executionHistory(fixture)).toHaveLength(0);
    expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(0);
    const model = await registerModel(fixture, {
      artifactId: artifact.id,
      weightsUri: null,
    });
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ modelVersionId: model.id, status: 'queued' }),
    ]);
    expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(1);
  });

  it('SDKのproject scopedモデル出力登録も同じ経路を通り、sourceRunをparentRunへ保存する', async () => {
    const fixture = await containerFixture(harness);
    const rule = await registerRule(fixture);
    const sourceRun = await fixture.newRun('SDK training run', 'training');
    const artifact = await uploadFixtureArtifact(harness, fixture, {
      path: 'model/weights.bin',
      runId: sourceRun.id,
    });
    const sdk = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'SDK output',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['registry:write'],
        },
      }),
    );
    const model = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        token: sdk.token,
        body: {
          version: 'sdk-output',
          sourceRunId: sourceRun.id,
          artifactId: artifact.id,
          parentModelVersionIds: [fixture.modelVersion.id],
        },
      }),
    );
    const execution = (await executionHistory(fixture))[0]!;
    expect(execution).toMatchObject({
      ruleId: rule.id,
      modelVersionId: model.id,
      status: 'queued',
    });
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${execution.runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(run.parentRunId).toBe(sourceRun.id);
    expect(run.createdBy).toBe(rule.createdBy);
  });

  it('weights URIもAPIからfetchせず、weightsなしならskipを記録して登録を残す', async () => {
    const fixture = await containerFixture(harness);
    await registerRule(fixture);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No URL fetching'));
    try {
      await registerModel(fixture);
      const noWeights = await registerModel(fixture, {
        version: 'metadata-only',
        weightsUri: null,
      });
      const history = await executionHistory(fixture);
      expect(history.find((execution) => execution.modelVersionId === noWeights.id)).toMatchObject({
        status: 'skipped',
        runId: null,
        jobId: null,
        runStatus: null,
        jobStatus: null,
        error: expect.stringContaining('weights_required'),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('同じ登録イベントの並行再処理とHTTP再送でもRun/Jobを増やさない', async () => {
    const fixture = await containerFixture(harness);
    const rule = await registerRule(fixture);
    const registrations = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { version: 'concurrent', weightsUri: 'https://weights.example.test/model' },
        }),
      ),
    );
    expect(registrations.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    const model = await entity<ModelVersion>(
      registrations.find((response) => response.status === 201)!,
    );
    await Promise.all(Array.from({ length: 4 }, () => replayRegistration(fixture, model)));
    const duplicates = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { version: model.version, weightsUri: model.weightsUri },
        }),
      ),
    );
    expect(duplicates.map((response) => response.status)).toEqual([409, 409, 409]);
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ ruleId: rule.id, modelVersionId: model.id }),
    ]);
    expect((await harness.database.query('SELECT * FROM runs')).rows).toHaveLength(1);
    expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(1);
    await expect(
      harness.database.query(
        `INSERT INTO model_automation_executions(project_id,rule_id,model_version_id,status,error) VALUES($1,$2,$3,'skipped','duplicate')`,
        [fixture.project.id, rule.id, model.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('disabled時の登録と過去モデルを、enableや新規ルールの作成後に再処理しない', async () => {
    const fixture = await containerFixture(harness);
    const past = await registerModel(fixture, { version: 'past' });
    const rule = await registerRule(fixture, {
      overrides: { enabled: false },
    });
    const disabled = await registerModel(fixture, {
      version: 'while-disabled',
    });
    expect(await executionHistory(fixture)).toHaveLength(0);
    await entity(
      await request(harness.app, `${fixture.basePath}/automation-rules/${rule.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: true },
      }),
      200,
    );
    await replayRegistration(fixture, past);
    await replayRegistration(fixture, disabled);
    await replayRegistration(fixture, fixture.modelVersion);
    expect(await executionHistory(fixture)).toHaveLength(0);
    const future = await registerModel(fixture, { version: 'after-enable' });
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({
        modelVersionId: future.id,
        status: 'queued',
      }),
    ]);
  });

  it('ルール対象外のmodel familyにはRun/Jobやexecutionを作らない', async () => {
    const fixture = await containerFixture(harness);
    await registerRule(fixture);
    const model = await entity<{ id: string }>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Qwen3', family: 'qwen3' },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v1',
          weightsUri: 'https://weights.example.test/qwen3',
        },
      }),
    );
    expect(await executionHistory(fixture)).toHaveLength(0);
    expect((await harness.database.query('SELECT * FROM runs')).rows).toHaveLength(0);
  });

  it('creatorの現在の管理者権限が失効したらskipを記録し、モデル登録を残す', async () => {
    const fixture = await containerFixture(harness);
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'admin' },
      }),
      200,
    );
    const rule = await registerRule(fixture, {
      cookie: fixture.editor.cookie,
    });
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'editor' },
      }),
      200,
    );
    const model = await registerModel(fixture);
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({
        ruleId: rule.id,
        modelVersionId: model.id,
        status: 'skipped',
        error: expect.stringContaining('creator_access_revoked'),
        runId: null,
        jobId: null,
      }),
    ]);
    expect((await harness.database.query('SELECT * FROM runs')).rows).toHaveLength(0);
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'admin' },
      }),
      200,
    );
    await replayRegistration(fixture, model);
    expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(0);
  });

  it('各ruleのJob保存失敗はsavepointでRunもrollbackし、次のruleとモデル登録を残す', async () => {
    const fixture = await containerFixture(harness);
    const failed = await registerRule(fixture, {
      overrides: { name: 'Failure', maxAttempts: 2 },
    });
    const successful = await registerRule(fixture, {
      overrides: { name: 'Success', kind: 'evaluation' },
    });
    await harness.database
      .query(`CREATE FUNCTION reject_fixture_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.max_attempts=2 THEN RAISE EXCEPTION 'fixture confidential SQL detail' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_fixture_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_fixture_job()`);
    try {
      const model = await registerModel(fixture);
      const history = await executionHistory(fixture);
      expect(history).toHaveLength(2);
      expect(history.find((execution) => execution.ruleId === failed.id)).toMatchObject({
        modelVersionId: model.id,
        status: 'failed',
        runId: null,
        jobId: null,
        error: expect.stringContaining('invalid_reference'),
      });
      expect(JSON.stringify(history)).not.toContain('confidential');
      expect(history.find((execution) => execution.ruleId === successful.id)).toMatchObject({
        status: 'queued',
        error: null,
      });
      expect((await harness.database.query('SELECT * FROM runs')).rows).toHaveLength(1);
      expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(1);
      expect(
        (await harness.database.query('SELECT id FROM model_versions WHERE id=$1', [model.id]))
          .rows,
      ).toHaveLength(1);
      await replayRegistration(fixture, model);
      expect(await executionHistory(fixture)).toHaveLength(2);
    } finally {
      await harness.database.query(
        'DROP TRIGGER reject_fixture_job ON jobs; DROP FUNCTION reject_fixture_job()',
      );
    }
  });

  it('targetが無効化またはruntime非対応になった場合もfailureを記録してモデル登録を残す', async () => {
    const fixture = await containerFixture(harness);
    await registerRule(fixture);
    await harness.database.query('UPDATE compute_targets SET enabled=false WHERE id=$1', [
      fixture.target.id,
    ]);
    const disabled = await registerModel(fixture, {
      version: 'target-disabled',
    });
    await harness.database.query(
      'UPDATE compute_targets SET enabled=true,runtime_kinds=$2 WHERE id=$1',
      [fixture.target.id, ['python']],
    );
    const incompatible = await registerModel(fixture, {
      version: 'runtime-unsupported',
    });
    const history = await executionHistory(fixture);
    expect(history.find((execution) => execution.modelVersionId === disabled.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('not_found'),
      runId: null,
    });
    expect(history.find((execution) => execution.modelVersionId === incompatible.id)).toMatchObject(
      {
        status: 'failed',
        error: expect.stringContaining('incompatible_runtime'),
        runId: null,
      },
    );
    expect((await harness.database.query('SELECT * FROM runs')).rows).toHaveLength(0);
    expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(0);
  });

  it('登録transactionが先に始まっていても、登録時点の有効ruleを実行する', async () => {
    const fixture = await containerFixture(harness);
    await transaction(harness.database, async (connection) => {
      // PostgreSQL now() uses transaction start, which must not determine rule eligibility.
      await registerRule(fixture);
      const inserted = await connection.query(
        `INSERT INTO model_versions(model_id,project_id,version,weights_uri)
        VALUES($1,$2,'long-registration','file:///fixture/weights') RETURNING id`,
        [fixture.model.id, fixture.project.id],
      );
      await harness.services.automation.processRegistration(connection, {
        projectId: fixture.project.id,
        modelVersionId: inserted.rows[0].id,
      });
    });
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ status: 'queued' }),
    ]);
    expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(1);
  });

  it('入力DatasetVersionが別Projectへ移るとfailureを記録し、モデル登録を残す', async () => {
    const fixture = await containerFixture(harness);
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Mutable fixture input' },
      }),
    );
    const version = await entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'v1', uri: 'file:///fixture/input', digest: 'fixture' },
      }),
    );
    const rule = await registerRule(fixture, {
      overrides: { inputDatasetVersionIds: [version.id] },
    });
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Foreign input project' },
      }),
    );
    const foreignDataset = await entity<Dataset>(
      await request(harness.app, `/api/projects/${other.id}/datasets`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Foreign input' },
      }),
    );
    // Simulate an invalid external writer only inside the isolated fixture schema.
    await harness.database.query(
      'ALTER TABLE dataset_versions DISABLE TRIGGER dataset_versions_immutable',
    );
    try {
      await harness.database.query(
        'UPDATE dataset_versions SET project_id=$2,dataset_id=$3 WHERE id=$1',
        [version.id, other.id, foreignDataset.id],
      );
    } finally {
      await harness.database.query(
        'ALTER TABLE dataset_versions ENABLE TRIGGER dataset_versions_immutable',
      );
    }
    const model = await registerModel(fixture);
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({
        ruleId: rule.id,
        modelVersionId: model.id,
        status: 'failed',
        runId: null,
        jobId: null,
        error: expect.stringContaining('not_found'),
      }),
    ]);
    expect((await harness.database.query('SELECT * FROM runs')).rows).toHaveLength(0);
    expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(0);
  });

  it('自動実行履歴は最新100件に制限する', async () => {
    const fixture = await containerFixture(harness);
    const rule = await registerRule(fixture);
    await harness.database.query(
      `WITH versions AS (
      INSERT INTO model_versions(model_id,project_id,version)
      SELECT $1,$2,'history-'||ordinal FROM generate_series(1,105) AS ordinal RETURNING id,version
    ) INSERT INTO model_automation_executions(project_id,rule_id,model_version_id,status,error,created_at)
      SELECT $2,$3,id,'skipped','history-'||substring(version FROM 9),
      timestamptz '2026-10-08 00:00:00Z'+substring(version FROM 9)::integer*interval '1 second' FROM versions`,
      [fixture.model.id, fixture.project.id, rule.id],
    );
    const history = await executionHistory(fixture);
    expect(history).toHaveLength(100);
    expect(history[0]!.error).toBe('history-105');
    expect(history.at(-1)!.error).toBe('history-6');
  });

  it('外側のモデル登録transactionが失敗したらイベント・Run・Jobもrollbackする', async () => {
    const fixture = await containerFixture(harness);
    await registerRule(fixture);
    const processRegistration = harness.services.automation.processRegistration.bind(
      harness.services.automation,
    );
    const rejected = vi
      .spyOn(harness.services.automation, 'processRegistration')
      .mockImplementation(async (connection, reference) => {
        await processRegistration(connection, reference);
        throw new DomainError(503, 'Fixture registration failure', 'fixture_failure');
      });
    try {
      expect(
        (
          await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: {
              version: 'rollback',
              weightsUri: 'https://weights.example.test/model',
            },
          })
        ).status,
      ).toBe(503);
      expect(
        (
          await harness.database.query('SELECT * FROM model_versions WHERE version=$1', [
            'rollback',
          ])
        ).rows,
      ).toHaveLength(0);
      expect((await harness.database.query('SELECT * FROM runs')).rows).toHaveLength(0);
      expect((await harness.database.query('SELECT * FROM jobs')).rows).toHaveLength(0);
      expect(
        (await harness.database.query('SELECT * FROM model_automation_executions')).rows,
      ).toHaveLength(0);
      expect(
        (await harness.database.query('SELECT * FROM model_automation_events')).rows,
      ).toHaveLength(1);
    } finally {
      rejected.mockRestore();
    }
    const model = await registerModel(fixture, { version: 'rollback' });
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ modelVersionId: model.id, status: 'queued' }),
    ]);
  });
});
