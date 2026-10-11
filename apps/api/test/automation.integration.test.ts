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
import {
  AUTOMATION_PENDING_MAX_AGE_HOURS,
  AutomationPendingSweeper,
} from '../src/services/automationPendingSweeper.js';
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

  async function finishWithoutJob(fixture: ContainerFixture, runId: string): Promise<void> {
    for (const status of ['running', 'finished'])
      await entity(
        await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status },
        }),
        200,
      );
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

  it('ruleのtagsに予約tag（automation.・mmt.）があれば422 reserved_tagで拒否する', async () => {
    const fixture = await containerFixture(harness);
    for (const tags of [{ 'automation.ruleId': 'forged' }, { 'mmt.source': 'rule' }]) {
      const response = await request(harness.app, `${fixture.basePath}/automation-rules`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: automationRuleInput(fixture, { tags }),
      });
      expect(response.status).toBe(422);
      expect(((await response.json()) as { code: string }).code).toBe('reserved_tag');
    }
    const rules = await harness.database.query('SELECT id FROM model_automation_rules');
    expect(rules.rows).toHaveLength(0);
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
    // Registered after training ended, so the rules run at registration.
    await finishWithoutJob(fixture, sourceRun.id);
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

  it('SDKのproject scopedモデル出力登録も同じ経路を通り、学習Runの成功後にsourceRunをparentRunへ保存する', async () => {
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
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ ruleId: rule.id, modelVersionId: model.id, status: 'pending' }),
    ]);
    await finishWithoutJob(fixture, sourceRun.id);
    const execution = (await executionHistory(fixture))[0]!;
    expect(execution).toMatchObject({
      ruleId: rule.id,
      modelVersionId: model.id,
      sourceRunId: sourceRun.id,
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
      overrides: { name: 'Failure', maxAttempts: 5 },
    });
    const successful = await registerRule(fixture, {
      overrides: { name: 'Success', kind: 'evaluation' },
    });
    await harness.database
      .query(`CREATE FUNCTION reject_fixture_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.max_attempts=5 THEN RAISE EXCEPTION 'fixture confidential SQL detail' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
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

  async function registerOutput(
    fixture: ContainerFixture,
    output: { sourceRunId: string; version: string },
  ): Promise<ModelVersion> {
    return registerModel(fixture, output);
  }

  async function startTrainingJob(fixture: ContainerFixture, name: string) {
    const run = await fixture.newRun(name, 'training');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id },
      }),
    );
    return { run, job };
  }

  async function claimJob(fixture: ContainerFixture, workerId: string): Promise<WorkerJob> {
    return (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId },
        }),
        200,
      )
    ).item;
  }

  async function completeJob(
    fixture: ContainerFixture,
    claimed: WorkerJob,
    status: 'finished' | 'failed',
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

  async function automaticRuns(): Promise<{ id: string; parent_run_id: string; status: string }[]> {
    return (
      await harness.database.query(
        "SELECT id,parent_run_id,status FROM runs WHERE tags ? 'automation.ruleId' ORDER BY created_at",
      )
    ).rows;
  }

  async function eventState(modelVersionId: string): Promise<string> {
    return (
      await harness.database.query<{ state: string }>(
        'SELECT state FROM model_automation_events WHERE model_version_id=$1',
        [modelVersionId],
      )
    ).rows[0]!.state;
  }

  it('学習Runのrunning中に登録したバージョンは保留し、worker completeのfinishedで1組だけ起動する', async () => {
    const fixture = await containerFixture(harness);
    const rule = await registerRule(fixture);
    const training = await startTrainingJob(fixture, 'Training');
    const claimed = await claimJob(fixture, 'training-worker');
    expect(claimed.job.id).toBe(training.job.id);
    const model = await registerOutput(fixture, {
      sourceRunId: training.run.id,
      version: 'trained',
    });

    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({
        ruleId: rule.id,
        modelVersionId: model.id,
        sourceRunId: training.run.id,
        status: 'pending',
        runId: null,
        jobId: null,
      }),
    ]);
    expect((await harness.database.query('SELECT * FROM model_automation_executions')).rows).toEqual(
      [],
    );
    expect(await automaticRuns()).toEqual([]);

    await completeJob(fixture, claimed, 'finished');
    await completeJob(fixture, claimed, 'finished');

    const history = await executionHistory(fixture);
    expect(history).toEqual([
      expect.objectContaining({ ruleId: rule.id, modelVersionId: model.id, status: 'queued' }),
    ]);
    expect(await automaticRuns()).toEqual([
      { id: history[0]!.runId, parent_run_id: training.run.id, status: 'queued' },
    ]);
    const jobs = await harness.database.query('SELECT * FROM jobs WHERE run_id=$1', [
      history[0]!.runId,
    ]);
    expect(jobs.rows).toEqual([expect.objectContaining({ status: 'queued' })]);
    expect(await eventState(model.id)).toBe('processed');
  });

  it('学習Runがfailed・canceledならskipped(source_run_unsuccessful)を残しJobを作らない', async () => {
    const fixture = await containerFixture(harness);
    const rule = await registerRule(fixture);
    const failing = await startTrainingJob(fixture, 'Failing training');
    const claimed = await claimJob(fixture, 'failing-worker');
    const failedModel = await registerOutput(fixture, {
      sourceRunId: failing.run.id,
      version: 'from-failed',
    });
    const canceled = await startTrainingJob(fixture, 'Canceled training');
    const canceledModel = await registerOutput(fixture, {
      sourceRunId: canceled.run.id,
      version: 'from-canceled',
    });

    await completeJob(fixture, claimed, 'failed');
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${canceled.job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );

    const history = await executionHistory(fixture);
    expect(history).toHaveLength(2);
    for (const model of [failedModel, canceledModel]) {
      expect(history.find((execution) => execution.modelVersionId === model.id)).toMatchObject({
        ruleId: rule.id,
        status: 'skipped',
        runId: null,
        jobId: null,
        error: expect.stringMatching(/^source_run_unsuccessful:/),
      });
      expect(await eventState(model.id)).toBe('source_unsuccessful');
    }
    expect(await automaticRuns()).toEqual([]);
  });

  it('保留中に無効化したruleは起動せず、保留中に作ったruleは終端時点の有効ruleとして起動する', async () => {
    const fixture = await containerFixture(harness);
    const disabledLater = await registerRule(fixture);
    const sourceRun = await fixture.newRun('Training', 'training');
    const model = await registerOutput(fixture, { sourceRunId: sourceRun.id, version: 'pending' });
    await entity(
      await request(harness.app, `${fixture.basePath}/automation-rules/${disabledLater.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: false },
      }),
      200,
    );
    expect(await executionHistory(fixture)).toEqual([]);
    const createdLater = await registerRule(fixture, { overrides: { name: 'Created later' } });
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ ruleId: createdLater.id, status: 'pending' }),
    ]);

    await finishWithoutJob(fixture, sourceRun.id);

    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ ruleId: createdLater.id, modelVersionId: model.id, status: 'queued' }),
    ]);
    // A version registered after its source Run ended does not wait.
    const afterFinish = await registerOutput(fixture, {
      sourceRunId: sourceRun.id,
      version: 'after-finish',
    });
    expect(await eventState(afterFinish.id)).toBe('processed');
    expect(
      (await executionHistory(fixture)).filter(
        (execution) => execution.modelVersionId === afterFinish.id,
      ),
    ).toEqual([expect.objectContaining({ ruleId: createdLater.id, status: 'queued' })]);
  });

  it('MLflowのrunning Run中にlog_modelして登録したバージョンも、UpdateRun FINISHEDで1回だけ起動する', async () => {
    const fixture = await containerFixture(harness);
    const rule = await registerRule(fixture);
    const mlflow = `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow`;
    const post = async <T>(endpoint: string, body: unknown, method = 'POST') =>
      entity<T>(
        await request(harness.app, `${mlflow}${endpoint}`, {
          method,
          cookie: fixture.editor.cookie,
          body,
        }),
        200,
      );
    const created = await post<{ run: { info: { run_id: string } } }>('/runs/create', {
      experiment_id: fixture.experiment.id,
    });
    const runId = created.run.info.run_id;
    const logged = await post<{ model: { info: { model_id: string } } }>('/logged-models', {
      experiment_id: fixture.experiment.id,
      source_run_id: runId,
      name: 'trained-model',
    });
    const loggedModelId = logged.model.info.model_id;
    for (const [path, contents] of Object.entries({
      MLmodel: 'flavors:\n  python_function:\n    loader_module: model\n    model_path: model.bin\n',
      'model.bin': 'trained weights',
    }))
      await entity(
        await request(
          harness.app,
          `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow-artifacts/artifacts/models/${loggedModelId}/artifacts/${path}`,
          { method: 'PUT', cookie: fixture.editor.cookie, binary: contents },
        ),
        200,
      );
    await post(
      `/logged-models/${loggedModelId}`,
      { model_id: loggedModelId, status: 'LOGGED_MODEL_READY' },
      'PATCH',
    );
    await post('/registered-models/create', {
      name: 'MLflow trained',
      tags: [{ key: 'mmt.model_family', value: 'qwen2' }],
    });
    await post('/model-versions/create', {
      name: 'MLflow trained',
      source: `models:/${loggedModelId}`,
      model_id: loggedModelId,
      run_id: runId,
    });
    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ ruleId: rule.id, sourceRunId: runId, status: 'pending' }),
    ]);

    for (const status of ['FINISHED', 'RUNNING', 'FINISHED'])
      await post('/runs/update', { run_id: runId, status });

    expect(await executionHistory(fixture)).toEqual([
      expect.objectContaining({ ruleId: rule.id, sourceRunId: runId, status: 'queued' }),
    ]);
    expect(await automaticRuns()).toEqual([expect.objectContaining({ parent_run_id: runId })]);
  });

  it('7日を超えた保留と削除済みsource Runの保留は、並行するsweeperでも1回だけskipped(source_run_timeout)にする', async () => {
    const fixture = await containerFixture(harness);
    const rule = await registerRule(fixture);
    const staleRun = await fixture.newRun('Stale training', 'training');
    const stale = await registerOutput(fixture, { sourceRunId: staleRun.id, version: 'stale' });
    const deletedRun = await fixture.newRun('Deleted training', 'training');
    const deleted = await registerOutput(fixture, {
      sourceRunId: deletedRun.id,
      version: 'deleted-source',
    });
    const freshRun = await fixture.newRun('Fresh training', 'training');
    const fresh = await registerOutput(fixture, { sourceRunId: freshRun.id, version: 'fresh' });
    await harness.database.query(
      `UPDATE model_automation_events SET pending_since=now()-make_interval(hours=>$2+1)
      WHERE model_version_id=$1`,
      [stale.id, AUTOMATION_PENDING_MAX_AGE_HOURS],
    );
    await harness.database.query("UPDATE runs SET lifecycle_stage='deleted' WHERE id=$1", [
      deletedRun.id,
    ]);

    const sweepers = Array.from(
      { length: 2 },
      () => new AutomationPendingSweeper(harness.database, harness.services.automation),
    );
    const expired = await Promise.all(sweepers.map((sweeper) => sweeper.sweep()));
    expect(expired.reduce((total, count) => total + count, 0)).toBe(2);
    expect(await Promise.all(sweepers.map((sweeper) => sweeper.sweep()))).toEqual([0, 0]);

    const history = await executionHistory(fixture);
    for (const model of [stale, deleted]) {
      expect(history.filter((execution) => execution.modelVersionId === model.id)).toEqual([
        expect.objectContaining({
          ruleId: rule.id,
          status: 'skipped',
          error: expect.stringMatching(/^source_run_timeout:/),
        }),
      ]);
      expect(await eventState(model.id)).toBe('source_timeout');
    }
    expect(await eventState(fresh.id)).toBe('pending');

    // Training that succeeds after the expiry no longer starts automation.
    await finishWithoutJob(fixture, staleRun.id);
    expect((await executionHistory(fixture)).filter((execution) => execution.modelVersionId === stale.id)).toHaveLength(1);
    expect(await automaticRuns()).toEqual([]);
  });
});
