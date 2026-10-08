import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Job,
  MetricPoint,
  ModelAutomationExecution,
  ModelAutomationRule,
  ModelVersion,
  Run,
  WorkerJob,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';
import { automationRuleInput, containerFixture } from './containerFixtures.js';

type ExecutionFixture = Awaited<ReturnType<typeof executionFixture>>;

const lateDataset = {
  name: 'late-dataset',
  digest: 'late123',
  source_type: 'http',
  source: '{"uri":"http://127.0.0.1:1/do-not-fetch"}',
};

describe.skipIf(!testDatabaseUrl)('予約tagと終端後のRun記録（独立PostgreSQL）', () => {
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

  function mlflow(fixture: ExecutionFixture) {
    const base = `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow`;
    return (endpoint: string, body: unknown) =>
      request(harness.app, `${base}${endpoint}`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body,
      });
  }

  async function mlflowRun(fixture: ExecutionFixture): Promise<string> {
    const created = await entity<{ run: { info: { run_id: string } } }>(
      await mlflow(fixture)('/runs/create', { experiment_id: fixture.experiment.id }),
      200,
    );
    return created.run.info.run_id;
  }

  async function finishedJobRun(fixture: ExecutionFixture): Promise<Run> {
    const run = await fixture.newRun('Job owned');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    const claimed = await entity<{ item: WorkerJob }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'integrity-worker' },
      }),
      200,
    );
    expect(claimed.item.job.id).toBe(job.id);
    await entity(
      await request(harness.app, `/api/worker/jobs/${job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: claimed.item.job.leaseId, status: 'finished', exitCode: 0 },
      }),
      200,
    );
    return run;
  }

  async function errorOf(response: Response, status: number) {
    expect(response.status).toBe(status);
    return (await response.json()) as { code?: string; error_code?: string };
  }

  async function storedRun(fixture: ExecutionFixture, runId: string): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  const metric: MetricPoint = {
    name: 'accuracy',
    value: 0.9,
    step: 1,
    timestamp: '2026-10-08T00:00:00.000Z',
  };

  it('native のRun作成とPATCHでは automation.* と mmt.* のtagを 422 reserved_tag で拒否する', async () => {
    const fixture = await executionFixture(harness);
    for (const key of ['automation.ruleId', 'mmt.source']) {
      const created = await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Forged',
          kind: 'evaluation',
          tags: { [key]: 'forged' },
        },
      });
      expect((await errorOf(created, 422)).code).toBe('reserved_tag');
    }
    const run = await fixture.newRun();
    const patched = await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
      method: 'PATCH',
      cookie: fixture.editor.cookie,
      body: { tags: { note: 'ok', 'automation.ruleId': 'forged' } },
    });
    expect((await errorOf(patched, 422)).code).toBe('reserved_tag');
    expect((await storedRun(fixture, run.id)).tags).toEqual({});

    await entity(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { tags: { 'mlflow.note.content': 'allowed', automation: 'not a prefix' } },
      }),
      200,
    );
  });

  it('MLflow の create・set-tag・delete-tag・log-batch では予約tagを INVALID_PARAMETER_VALUE で拒否する', async () => {
    const fixture = await executionFixture(harness);
    const post = mlflow(fixture);
    const created = await post('/runs/create', {
      experiment_id: fixture.experiment.id,
      tags: [{ key: 'mmt.evaluation', value: 'forged' }],
    });
    expect((await errorOf(created, 400)).error_code).toBe('INVALID_PARAMETER_VALUE');

    const runId = await mlflowRun(fixture);
    for (const [endpoint, body] of [
      ['/runs/set-tag', { run_id: runId, key: 'automation.ruleId', value: 'forged' }],
      ['/runs/delete-tag', { run_id: runId, key: 'automation.ruleId' }],
      [
        '/runs/log-batch',
        { run_id: runId, tags: [{ key: 'mmt.promotion', value: 'forged' }], metrics: [] },
      ],
    ] as const) {
      const response = await post(endpoint, body);
      expect((await errorOf(response, 400)).error_code).toBe('INVALID_PARAMETER_VALUE');
    }

    await entity(
      await post('/runs/set-tag', { run_id: runId, key: 'mlflow.runName', value: 'renamed' }),
      200,
    );
    const stored = await storedRun(fixture, runId);
    expect(stored.name).toBe('renamed');
    expect(Object.keys(stored.tags).filter((key) => !key.startsWith('mlflow.'))).toEqual([]);
  });

  it('予約tagを持つ既存Runからも利用者はその tag を削除できない', async () => {
    const fixture = await executionFixture(harness);
    const runId = await mlflowRun(fixture);
    await harness.database.query(
      `UPDATE runs SET tags=tags||'{"automation.ruleId":"legacy"}'::jsonb WHERE id=$1`,
      [runId],
    );
    const response = await mlflow(fixture)('/runs/delete-tag', {
      run_id: runId,
      key: 'automation.ruleId',
    });
    expect((await errorOf(response, 400)).error_code).toBe('INVALID_PARAMETER_VALUE');
    expect((await storedRun(fixture, runId)).tags['automation.ruleId']).toBe('legacy');
  });

  it('Jobが付いたRunが finished になった後は native の metrics・tags・params を 409 run_finalized で拒否する', async () => {
    const fixture = await executionFixture(harness);
    const run = await finishedJobRun(fixture);
    expect((await storedRun(fixture, run.id)).status).toBe('finished');

    const metrics = await request(harness.app, `${fixture.basePath}/runs/${run.id}/metrics`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { metrics: [metric] },
    });
    expect((await errorOf(metrics, 409)).code).toBe('run_finalized');
    for (const body of [{ tags: { score: 'forged' } }, { parameters: { threshold: 1 } }]) {
      const patched = await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body,
      });
      expect((await errorOf(patched, 409)).code).toBe('run_finalized');
    }
    const stored = await storedRun(fixture, run.id);
    expect(stored.tags).toEqual({});
    expect(
      await entity<{ items: MetricPoint[] }>(
        await request(harness.app, `${fixture.basePath}/runs/${run.id}/metrics`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      ),
    ).toEqual({ items: [] });

    // Renaming and diagnostics logs are not evidence, so they stay available.
    await entity(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { name: 'Renamed after finish' },
      }),
      200,
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/runs/${run.id}/logs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            entries: [{ timestamp: metric.timestamp, level: 'info', message: 'late log' }],
          },
        })
      ).status,
    ).toBe(204);
  });

  it('Jobが付いたRunが finished になった後は MLflow の各書き込みを INVALID_STATE で拒否する', async () => {
    const fixture = await executionFixture(harness);
    const run = await finishedJobRun(fixture);
    const post = mlflow(fixture);
    for (const [endpoint, body] of [
      ['/runs/log-metric', { run_id: run.id, key: 'accuracy', value: 0.9, timestamp: 1, step: 1 }],
      ['/runs/log-parameter', { run_id: run.id, key: 'threshold', value: '1' }],
      ['/runs/set-tag', { run_id: run.id, key: 'score', value: 'forged' }],
      ['/runs/delete-tag', { run_id: run.id, key: 'mlflow.runName' }],
      [
        '/runs/log-batch',
        {
          run_id: run.id,
          metrics: [{ key: 'accuracy', value: 0.9, timestamp: 1, step: 1 }],
          params: [],
          tags: [],
        },
      ],
      ['/runs/log-inputs', { run_id: run.id, datasets: [{ dataset: lateDataset, tags: [] }] }],
    ] as const) {
      const response = await post(endpoint, body);
      expect({ endpoint, ...(await errorOf(response, 409)) }).toMatchObject({
        endpoint,
        error_code: 'INVALID_STATE',
      });
    }
    const stored = await storedRun(fixture, run.id);
    expect(stored.inputDatasetVersionIds).toEqual([]);
    expect(stored.parameters).toEqual(run.parameters);
    const datasets = await harness.database.query('SELECT identity FROM mlflow_datasets');
    expect(datasets.rows).toEqual([]);
  });

  it('Jobが付かない MLflow Run は終端後も metrics・params・tags・inputs を書ける', async () => {
    const fixture = await executionFixture(harness);
    const post = mlflow(fixture);
    const runId = await mlflowRun(fixture);
    await entity(await post('/runs/update', { run_id: runId, status: 'FINISHED' }), 200);
    for (const [endpoint, body] of [
      ['/runs/log-metric', { run_id: runId, key: 'accuracy', value: 0.9, timestamp: 1, step: 1 }],
      ['/runs/log-parameter', { run_id: runId, key: 'threshold', value: '1' }],
      ['/runs/set-tag', { run_id: runId, key: 'score', value: 'late' }],
      ['/runs/log-inputs', { run_id: runId, datasets: [{ dataset: lateDataset, tags: [] }] }],
    ] as const)
      await entity(await post(endpoint, body), 200);
    await entity(await post('/runs/delete-tag', { run_id: runId, key: 'score' }), 200);

    const stored = await storedRun(fixture, runId);
    expect(stored.status).toBe('finished');
    expect(stored.parameters).toMatchObject({ threshold: '1' });
    expect(stored.inputDatasetVersionIds).toHaveLength(1);
    expect(stored.tags.score).toBeUndefined();
  });

  it('自動実行が作るRunには automation.ruleId が付き続ける', async () => {
    const fixture = await containerFixture(harness);
    const rule = await entity<ModelAutomationRule>(
      await request(harness.app, `${fixture.basePath}/automation-rules`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: automationRuleInput(fixture, { tags: { purpose: 'inference' } }),
      }),
    );
    await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'weights-v1', weightsUri: 'https://weights.example.test/weights.bin' },
      }),
    );
    const executions = await entity<{ items: ModelAutomationExecution[] }>(
      await request(harness.app, `${fixture.basePath}/automation-executions`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    const execution = executions.items.find((item) => item.ruleId === rule.id)!;
    expect(execution.runId).toBeTruthy();
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${execution.runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(run.tags).toEqual({ purpose: 'inference', 'automation.ruleId': rule.id });
  });
});
