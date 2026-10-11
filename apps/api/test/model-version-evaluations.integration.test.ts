import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Model,
  ModelAutomationExecution,
  ModelAutomationExecutionPage,
  ModelAutomationRule,
  ModelVersion,
  ModelVersionDetail,
  ModelVersionEvaluationSummary,
  Run,
  RunDownstreamPage,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import {
  automationRuleInput,
  containerFixture,
  type ContainerFixture,
} from './containerFixtures.js';
import { trackingClient } from './mlflow-tracking-fixtures.js';

describe.skipIf(!testDatabaseUrl)('モデルバージョンの評価集約とexecutionの絞り込み（独立PostgreSQL）', () => {
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

  async function createRule(
    fixture: ContainerFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<Response> {
    return request(harness.app, `${fixture.basePath}/automation-rules`, {
      method: 'POST',
      cookie: fixture.administrator.cookie,
      body: automationRuleInput(fixture, overrides),
    });
  }

  async function registerVersion(fixture: ContainerFixture, version: string): Promise<ModelVersion> {
    return entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version, weightsUri: `https://weights.example.test/${version}.bin` },
      }),
    );
  }

  async function createRun(
    fixture: ContainerFixture,
    run: { name: string; kind: Run['kind']; modelVersionId?: string; parentRunId?: string },
  ): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, ...run },
      }),
    );
  }

  async function logMetric(
    fixture: ContainerFixture,
    metric: { runId: string; name: string; value: number },
  ): Promise<void> {
    const response = await request(harness.app, `${fixture.basePath}/runs/${metric.runId}/metrics`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        metrics: [
          { name: metric.name, value: metric.value, step: 0, timestamp: new Date().toISOString() },
        ],
      },
    });
    expect(response.status).toBe(204);
  }

  async function evaluations(
    fixture: ContainerFixture,
    versionId: string,
    query = '',
    cookie = fixture.viewer.cookie,
  ): Promise<Response> {
    return request(
      harness.app,
      `${fixture.basePath}/model-versions/${versionId}/evaluations${query}`,
      { cookie },
    );
  }

  async function executionPage(
    fixture: ContainerFixture,
    query: Record<string, string>,
  ): Promise<Response> {
    return request(
      harness.app,
      `${fixture.basePath}/automation-executions?${new URLSearchParams(query)}`,
      { cookie: fixture.viewer.cookie },
    );
  }

  it('評価Run2件のバージョンは2件とlatestMetricsを返し、削除済みと別のバージョンのRunを含めない', async () => {
    const fixture = await containerFixture(harness);
    const version = await registerVersion(fixture, 'candidate');
    const other = await registerVersion(fixture, 'other');
    const first = await createRun(fixture, {
      name: 'eval-1',
      kind: 'evaluation',
      modelVersionId: version.id,
    });
    const second = await createRun(fixture, {
      name: 'eval-2',
      kind: 'evaluation',
      modelVersionId: version.id,
    });
    const deleted = await createRun(fixture, {
      name: 'eval-deleted',
      kind: 'evaluation',
      modelVersionId: version.id,
    });
    await createRun(fixture, { name: 'eval-other', kind: 'evaluation', modelVersionId: other.id });
    await createRun(fixture, { name: 'inference', kind: 'inference', modelVersionId: version.id });
    await logMetric(fixture, { runId: first.id, name: 'wer', value: 0.25 });
    await logMetric(fixture, { runId: second.id, name: 'wer', value: 0.2 });
    await entity(
      await trackingClient(harness.app, fixture).post('/runs/delete', { run_id: deleted.id }),
      200,
    );

    const summary = await entity<ModelVersionEvaluationSummary>(
      await evaluations(fixture, version.id, '?kind=evaluation'),
      200,
    );
    expect(summary.modelVersionId).toBe(version.id);
    expect(summary.items.map((run) => run.id)).toEqual([second.id, first.id]);
    expect(summary.items.map((run) => run.latestMetrics)).toEqual([{ wer: 0.2 }, { wer: 0.25 }]);
    // Runs a person created are never automatic, whatever their tags say.
    expect(summary.items.every((run) => !run.automatic && run.ruleId === null)).toBe(true);
    expect(summary.nextCursor).toBeNull();

    const everyKind = await entity<ModelVersionEvaluationSummary>(
      await evaluations(fixture, version.id),
      200,
    );
    expect(everyKind.items.map((run) => run.kind).sort()).toEqual([
      'evaluation',
      'evaluation',
      'inference',
    ]);
  });

  it('自動実行が作った評価Runはautomaticとruleを返し、正解セットと上流出力を分ける', async () => {
    const fixture = await containerFixture(harness);
    const rule = await entity<ModelAutomationRule>(
      await createRule(fixture, { name: 'Automatic evaluation', kind: 'evaluation' }),
    );
    const version = await registerVersion(fixture, 'automatic');
    const manual = await createRun(fixture, {
      name: 'manual-eval',
      kind: 'evaluation',
      modelVersionId: version.id,
    });

    const summary = await entity<ModelVersionEvaluationSummary>(
      await evaluations(fixture, version.id, '?kind=evaluation'),
      200,
    );
    const automatic = summary.items.find((run) => run.id !== manual.id)!;
    expect(automatic).toMatchObject({
      automatic: true,
      ruleId: rule.id,
      referenceDatasetVersionIds: [],
      upstreamDatasetVersionIds: [],
    });
    expect(automatic.pipelineRootExecutionId).toBe(automatic.executionId);
    expect(summary.items.find((run) => run.id === manual.id)).toMatchObject({
      automatic: false,
      ruleId: null,
      executionId: null,
    });
  });

  it('viewerはバージョンと評価一覧を読め、別Projectのバージョンは404、非メンバーは403', async () => {
    const fixture = await containerFixture(harness);
    const version = await registerVersion(fixture, 'readable');
    await entity(
      await request(
        harness.app,
        `${fixture.basePath}/models/${fixture.model.id}/aliases/production`,
        {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { versionId: version.id },
        },
      ),
      200,
    );
    const detail = await entity<ModelVersionDetail>(
      await request(harness.app, `${fixture.basePath}/model-versions/${version.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(detail.version.id).toBe(version.id);
    expect(detail.model.id).toBe(fixture.model.id);
    expect(detail.aliases).toEqual(['production']);

    const otherProject = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherModel = await entity<Model>(
      await request(harness.app, `/api/projects/${otherProject.id}/models`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other model', family: 'qwen2' },
      }),
    );
    const otherVersion = await entity<ModelVersion>(
      await request(harness.app, `/api/projects/${otherProject.id}/models/${otherModel.id}/versions`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { version: 'foreign', weightsUri: 'https://weights.example.test/foreign.bin' },
      }),
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/model-versions/${otherVersion.id}`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
    expect((await evaluations(fixture, otherVersion.id)).status).toBe(404);
    expect(
      (await evaluations(fixture, version.id, '', fixture.outsider.cookie)).status,
    ).toBe(403);
  });

  it('評価一覧は同じ作成時刻のRunでもcursorで重複・欠落なくたどれる', async () => {
    const fixture = await containerFixture(harness);
    const version = await registerVersion(fixture, 'paged');
    const created: Run[] = [];
    for (const name of ['a', 'b', 'c'])
      created.push(
        await createRun(fixture, { name, kind: 'evaluation', modelVersionId: version.id }),
      );
    await harness.database.query(
      `UPDATE runs SET created_at='2026-10-08T00:00:00.123456Z' WHERE id=ANY($1::uuid[])`,
      [created.map((run) => run.id)],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const page: ModelVersionEvaluationSummary = await entity<ModelVersionEvaluationSummary>(
        await evaluations(fixture, version.id, query),
        200,
      );
      seen.push(...page.items.map((run) => run.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(created.map((run) => run.id).sort().reverse());
    expect((await evaluations(fixture, version.id, `?cursor=${fixture.project.id}`)).status).toBe(
      404,
    );
  });

  it('executionsはmodelVersionIdとruleIdで絞り込め、同一時刻の複数件をcursorで1件ずつたどれる', async () => {
    const fixture = await containerFixture(harness);
    const rules: ModelAutomationRule[] = [];
    for (const name of ['first', 'second', 'third'])
      rules.push(await entity<ModelAutomationRule>(await createRule(fixture, { name })));
    // All executions of one registration are inserted in one transaction, so they share now().
    const target = await registerVersion(fixture, 'target');
    const other = await registerVersion(fixture, 'other');

    const all = await entity<ModelAutomationExecutionPage>(await executionPage(fixture, {}), 200);
    expect(all.items).toHaveLength(6);
    expect(all.nextCursor).toBeNull();

    const seen: ModelAutomationExecution[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelAutomationExecutionPage = await entity<ModelAutomationExecutionPage>(
        await executionPage(fixture, {
          modelVersionId: target.id,
          limit: '1',
          ...(cursor ? { cursor } : {}),
        }),
        200,
      );
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((execution) => execution.createdAt)).size).toBe(1);
    expect(seen.every((execution) => execution.modelVersionId === target.id)).toBe(true);
    expect(seen.map((execution) => execution.id)).toEqual(
      seen.map((execution) => execution.id).sort().reverse(),
    );
    expect(seen.every((execution) => execution.runStartedAt === null)).toBe(true);

    const byRule = await entity<ModelAutomationExecutionPage>(
      await executionPage(fixture, { modelVersionId: other.id, ruleId: rules[1]!.id }),
      200,
    );
    expect(byRule.items.map((execution) => [execution.ruleId, execution.modelVersionId])).toEqual([
      [rules[1]!.id, other.id],
    ]);
    // A cursor outside the filtered list is rejected rather than silently restarting.
    expect(
      (await executionPage(fixture, { modelVersionId: other.id, cursor: seen[0]!.id })).status,
    ).toBe(404);
    expect((await executionPage(fixture, { limit: '201' })).status).toBe(422);
  });

  it('保留中の登録もmodelVersionIdで絞り込んだexecutionsに含まれる', async () => {
    const fixture = await containerFixture(harness);
    const rule = await entity<ModelAutomationRule>(await createRule(fixture));
    const training = await createRun(fixture, { name: 'training', kind: 'training' });
    const version = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'pending',
          weightsUri: 'https://weights.example.test/pending.bin',
          sourceRunId: training.id,
        },
      }),
    );
    const page = await entity<ModelAutomationExecutionPage>(
      await executionPage(fixture, { modelVersionId: version.id }),
      200,
    );
    expect(page.items.map((execution) => [execution.status, execution.ruleId])).toEqual([
      ['pending', rule.id],
    ]);
    const next = await entity<ModelAutomationExecutionPage>(
      await executionPage(fixture, { modelVersionId: version.id, cursor: page.items[0]!.id }),
      200,
    );
    expect(next.items).toEqual([]);
  });

  it('summaryMetricsを保存し、ruleの他の設定と同じく変更できない', async () => {
    const fixture = await containerFixture(harness);
    const rule = await entity<ModelAutomationRule>(
      await createRule(fixture, { kind: 'evaluation', summaryMetrics: ['wer', 'cer'] }),
    );
    expect(rule.summaryMetrics).toEqual(['wer', 'cer']);
    const defaulted = await entity<ModelAutomationRule>(await createRule(fixture, { name: 'plain' }));
    expect(defaulted.summaryMetrics).toEqual([]);

    const toggled = await entity<ModelAutomationRule>(
      await request(harness.app, `${fixture.basePath}/automation-rules/${rule.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: false },
      }),
      200,
    );
    expect(toggled.summaryMetrics).toEqual(['wer', 'cer']);
    await expect(
      harness.database.query(
        `UPDATE model_automation_rules SET summary_metrics='{bleu}' WHERE id=$1`,
        [rule.id],
      ),
    ).rejects.toThrow(/immutable/);

    for (const summaryMetrics of [
      ['wer', 'wer'],
      Array.from({ length: 21 }, (_, index) => `metric-${index}`),
      [''],
    ])
      expect((await createRule(fixture, { name: 'invalid', summaryMetrics })).status).toBe(422);
  });

  it('downstreamは親Runの子Runを自動実行の印つきで返し、別Projectや存在しないRunは404', async () => {
    const fixture = await containerFixture(harness);
    await entity<ModelAutomationRule>(await createRule(fixture));
    const training = await createRun(fixture, { name: 'training', kind: 'training' });
    const version = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'trained',
          weightsUri: 'https://weights.example.test/trained.bin',
          sourceRunId: training.id,
        },
      }),
    );
    const child = await createRun(fixture, {
      name: 'manual child',
      kind: 'evaluation',
      modelVersionId: version.id,
      parentRunId: training.id,
    });
    // Finishing the training Run releases the pending registration, which starts the rule's Run
    // under the training Run.
    for (const status of ['running', 'finished'])
      await entity(
        await request(harness.app, `${fixture.basePath}/runs/${training.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status },
        }),
        200,
      );

    const downstream = await entity<RunDownstreamPage>(
      await request(harness.app, `${fixture.basePath}/runs/${training.id}/downstream`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(downstream.runId).toBe(training.id);
    expect(downstream.items).toHaveLength(2);
    expect(downstream.items.find((run) => run.id === child.id)?.automatic).toBe(false);
    expect(downstream.items.find((run) => run.id !== child.id)).toMatchObject({
      automatic: true,
      kind: 'inference',
      modelVersionId: version.id,
    });
    expect(
      (
        await request(harness.app, `${fixture.basePath}/runs/${fixture.project.id}/downstream`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
  });
});
