import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  CodeVersion,
  Dataset,
  DatasetVersion,
  EvaluationComparison,
  ModelVersion,
  Project,
  Run,
  RunStatus,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

async function evaluationFixture(harness: Harness) {
  const fixture = await executionFixture(harness);
  const { basePath, editor, administrator } = fixture;
  const baseline = fixture.modelVersion;
  const candidate = await entity<ModelVersion>(
    await request(harness.app, `${basePath}/models/${fixture.model.id}/versions`, {
      method: 'POST',
      cookie: editor.cookie,
      body: { version: 'candidate' },
    }),
  );
  const otherCodeVersion = await entity<CodeVersion>(
    await request(harness.app, `${basePath}/codes/${fixture.code.id}/versions`, {
      method: 'POST',
      cookie: editor.cookie,
      body: {
        version: 'v2',
        source: { kind: 'inline', files: { 'main.py': 'print("evaluate v2")\n' } },
        entrypoint: ['python', 'main.py'],
        supportedModelFamilies: ['qwen2'],
        taskTypes: ['evaluation'],
      },
    }),
  );
  const dataset = await entity<Dataset>(
    await request(harness.app, `${basePath}/datasets`, {
      method: 'POST',
      cookie: editor.cookie,
      body: { name: 'Evaluation data' },
    }),
  );
  async function datasetVersion(version: string): Promise<DatasetVersion> {
    return entity<DatasetVersion>(
      await request(harness.app, `${basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: editor.cookie,
        body: { version, uri: `s3://evaluation/${version}`, digest: `digest-${version}` },
      }),
    );
  }
  const referenceA = await datasetVersion('reference-a');
  const referenceB = await datasetVersion('reference-b');
  const referenceC = await datasetVersion('reference-c');
  const candidatePredictions = await datasetVersion('predictions-candidate');
  const baselinePredictions = await datasetVersion('predictions-baseline');
  await entity(
    await request(harness.app, `${basePath}/models/${fixture.model.id}/aliases/production`, {
      method: 'PUT',
      cookie: editor.cookie,
      body: { versionId: baseline.id },
    }),
    200,
  );

  // Upstream outputs are set only by the automation chain, so tests insert evaluation Runs directly.
  async function insertEvaluationRun(run: {
    modelVersionId: string;
    inputs: string[];
    upstream?: string[];
    codeVersionId?: string | null;
    status?: RunStatus;
    endedAt?: string;
    lifecycleStage?: 'active' | 'deleted';
    kind?: 'evaluation' | 'inference';
    latestMetrics?: Record<string, number>;
  }): Promise<string> {
    const inserted = await harness.database.query<{ id: string }>(
      `INSERT INTO runs(project_id,experiment_id,name,kind,status,model_version_id,code_version_id,
        input_dataset_version_ids,upstream_dataset_version_ids,latest_metrics,created_by,ended_at,lifecycle_stage)
      VALUES($1,$2,'Evaluation',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        fixture.project.id,
        fixture.experiment.id,
        run.kind ?? 'evaluation',
        run.status ?? 'finished',
        run.modelVersionId,
        run.codeVersionId === undefined ? fixture.codeVersion.id : run.codeVersionId,
        run.inputs,
        run.upstream ?? [],
        JSON.stringify(run.latestMetrics ?? {}),
        editor.userId,
        run.endedAt ?? '2026-10-01T00:00:00Z',
        run.lifecycleStage ?? 'active',
      ],
    );
    return inserted.rows[0]!.id;
  }
  async function insertMetricPoint(point: {
    runId: string;
    name: string;
    value: number;
    step: number;
    datasetDigest: string | null;
  }): Promise<void> {
    await harness.database.query(
      `INSERT INTO metrics(run_id,name,value,step,timestamp,mlflow_logged,mlflow_dataset_digest)
      VALUES($1,$2,$3,$4,now(),true,$5)`,
      [point.runId, point.name, point.value, point.step, point.datasetDigest],
    );
  }
  async function compare(
    query: Record<string, string> = {},
    options: { cookie?: string; token?: string; versionId?: string } = {
      cookie: fixture.viewer.cookie,
    },
  ): Promise<Response> {
    const search = new URLSearchParams(query).toString();
    return request(
      harness.app,
      `${basePath}/models/${fixture.model.id}/versions/${options.versionId ?? candidate.id}/evaluation-comparison${search ? `?${search}` : ''}`,
      { cookie: options.cookie, token: options.token },
    );
  }
  return {
    ...fixture,
    administrator,
    baseline,
    candidate,
    otherCodeVersion,
    referenceA,
    referenceB,
    referenceC,
    candidatePredictions,
    baselinePredictions,
    insertEvaluationRun,
    insertMetricPoint,
    compare,
  };
}

describe.skipIf(!testDatabaseUrl)('評価結果の基準バージョンとの比較（独立PostgreSQL）', () => {
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

  it('upstreamDatasetVersionIdsはRunの応答に含まれ、入力の部分集合で作成後は変更できない', async () => {
    const fixture = await evaluationFixture(harness);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Manual evaluation',
          kind: 'evaluation',
          inputDatasetVersionIds: [fixture.referenceA.id],
        },
      }),
    );
    expect(run.upstreamDatasetVersionIds).toEqual([]);
    const list = await entity<{ items: Run[] }>(
      await request(harness.app, `${fixture.basePath}/runs`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(list.items.find((item) => item.id === run.id)?.upstreamDatasetVersionIds).toEqual([]);

    await expect(
      harness.database.query('UPDATE runs SET upstream_dataset_version_ids=$2 WHERE id=$1', [
        run.id,
        [fixture.referenceA.id],
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      fixture.insertEvaluationRun({
        modelVersionId: fixture.candidate.id,
        inputs: [fixture.referenceA.id],
        upstream: [fixture.candidatePredictions.id],
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('上流出力だけが違う候補と基準は、正解セットの順序が違っても同じ条件として比べる', async () => {
    const fixture = await evaluationFixture(harness);
    const candidateRunId = await fixture.insertEvaluationRun({
      modelVersionId: fixture.candidate.id,
      inputs: [fixture.referenceB.id, fixture.candidatePredictions.id, fixture.referenceA.id],
      upstream: [fixture.candidatePredictions.id],
      latestMetrics: { accuracy: 0.9, wer: 0.1 },
    });
    const baselineRunId = await fixture.insertEvaluationRun({
      modelVersionId: fixture.baseline.id,
      inputs: [fixture.referenceA.id, fixture.referenceB.id, fixture.baselinePredictions.id],
      upstream: [fixture.baselinePredictions.id],
      latestMetrics: { accuracy: 0.8, wer: 0 },
    });
    const comparison = await entity<EvaluationComparison>(await fixture.compare(), 200);
    expect(comparison).toMatchObject({
      status: 'ok',
      modelId: fixture.model.id,
      candidateVersionId: fixture.candidate.id,
      baselineAlias: 'production',
      baselineVersionId: fixture.baseline.id,
      candidateRunId,
      baselineRunId,
      referenceDatasetVersionIds: [fixture.referenceA.id, fixture.referenceB.id].sort(),
      codeVersionId: fixture.codeVersion.id,
      evaluationRuleId: null,
    });
    expect(comparison.metrics.map((metric) => metric.key)).toEqual(['accuracy', 'wer']);
    expect(comparison.metrics[0]!.delta).toBeCloseTo(0.1);
    expect(comparison.metrics[0]!.relativeDelta).toBeCloseTo(0.125);
    expect(comparison.metrics[1]).toMatchObject({ delta: 0.1, relativeDelta: null });
    expect(comparison.metrics[0]!.source).toEqual({ candidate: 'run_latest', baseline: 'run_latest' });
  });

  it('正解セットが1つ多い基準や、評価CodeVersionが違う基準とは比べない', async () => {
    const fixture = await evaluationFixture(harness);
    await fixture.insertEvaluationRun({
      modelVersionId: fixture.candidate.id,
      inputs: [fixture.referenceA.id, fixture.referenceB.id],
      latestMetrics: { accuracy: 0.9 },
    });
    await fixture.insertEvaluationRun({
      modelVersionId: fixture.baseline.id,
      inputs: [fixture.referenceA.id, fixture.referenceB.id, fixture.referenceC.id],
      latestMetrics: { accuracy: 0.8 },
    });
    await fixture.insertEvaluationRun({
      modelVersionId: fixture.baseline.id,
      inputs: [fixture.referenceA.id, fixture.referenceB.id],
      codeVersionId: fixture.otherCodeVersion.id,
      latestMetrics: { accuracy: 0.7 },
    });
    const comparison = await entity<EvaluationComparison>(await fixture.compare(), 200);
    expect(comparison).toMatchObject({ status: 'baseline_not_evaluated', baselineRunId: null });
    // 基準がなくても、候補の値は並べる。
    expect(comparison.metrics).toEqual([
      expect.objectContaining({ key: 'accuracy', candidate: 0.9, baselineStatus: 'missing' }),
    ]);

    const byOtherCode = await entity<EvaluationComparison>(
      await fixture.compare({ codeVersionId: fixture.otherCodeVersion.id }),
      200,
    );
    expect(byOtherCode.status).toBe('candidate_not_evaluated');
  });

  it('failed・canceled・削除済み・評価以外のRunを除き、最新のended_atの評価を選ぶ', async () => {
    const fixture = await evaluationFixture(harness);
    const inputs = [fixture.referenceA.id];
    await fixture.insertEvaluationRun({
      modelVersionId: fixture.candidate.id,
      inputs,
      endedAt: '2026-10-01T00:00:00Z',
      latestMetrics: { accuracy: 0.1 },
    });
    const latestCandidate = await fixture.insertEvaluationRun({
      modelVersionId: fixture.candidate.id,
      inputs,
      endedAt: '2026-10-02T00:00:00Z',
      latestMetrics: { accuracy: 0.9 },
    });
    await fixture.insertEvaluationRun({
      modelVersionId: fixture.baseline.id,
      inputs,
      endedAt: '2026-10-01T00:00:00Z',
      latestMetrics: { accuracy: 0.5 },
    });
    const latestBaseline = await fixture.insertEvaluationRun({
      modelVersionId: fixture.baseline.id,
      inputs,
      endedAt: '2026-10-02T00:00:00Z',
      latestMetrics: { accuracy: 0.6 },
    });
    for (const excluded of [
      { status: 'failed' as const },
      { status: 'canceled' as const },
      { lifecycleStage: 'deleted' as const },
      { kind: 'inference' as const },
    ])
      await fixture.insertEvaluationRun({
        modelVersionId: fixture.baseline.id,
        inputs,
        endedAt: '2026-10-05T00:00:00Z',
        latestMetrics: { accuracy: 0.0 },
        ...excluded,
      });
    const comparison = await entity<EvaluationComparison>(await fixture.compare(), 200);
    expect(comparison).toMatchObject({
      status: 'ok',
      candidateRunId: latestCandidate,
      baselineRunId: latestBaseline,
    });
    expect(comparison.metrics[0]).toMatchObject({ candidate: 0.9, baseline: 0.6 });
  });

  it('evaluationRuleIdを指定すると、そのruleの自動実行が作ったRunだけを比べ、手動の評価Runを除く', async () => {
    const fixture = await evaluationFixture(harness);
    const rule = await harness.database.query<{ id: string }>(
      `INSERT INTO model_automation_rules(project_id,name,model_families,kind,experiment_id,code_version_id,target_id,created_by)
      VALUES($1,'Evaluate',ARRAY['qwen2'],'evaluation',$2,$3,$4,$5) RETURNING id`,
      [
        fixture.project.id,
        fixture.experiment.id,
        fixture.codeVersion.id,
        fixture.target.id,
        fixture.administrator.userId,
      ],
    );
    const ruleId = rule.rows[0]!.id;
    const inputs = [fixture.referenceA.id];
    const automatedRuns: Record<string, string> = {};
    for (const version of [fixture.candidate, fixture.baseline]) {
      const runId = await fixture.insertEvaluationRun({
        modelVersionId: version.id,
        inputs,
        endedAt: '2026-10-01T00:00:00Z',
        latestMetrics: { accuracy: 0.5 },
      });
      const job = await harness.database.query<{ id: string }>(
        'INSERT INTO jobs(project_id,run_id,target_id,status) VALUES($1,$2,$3,$4) RETURNING id',
        [fixture.project.id, runId, fixture.target.id, 'finished'],
      );
      await harness.database.query(
        `INSERT INTO model_automation_executions(project_id,rule_id,model_version_id,run_id,job_id,status)
        VALUES($1,$2,$3,$4,$5,'queued')`,
        [fixture.project.id, ruleId, version.id, runId, job.rows[0]!.id],
      );
      automatedRuns[version.id] = runId;
      // A newer manual evaluation of the same version under the same conditions.
      await fixture.insertEvaluationRun({
        modelVersionId: version.id,
        inputs,
        endedAt: '2026-10-03T00:00:00Z',
        latestMetrics: { accuracy: 0.99 },
      });
    }
    const byRule = await entity<EvaluationComparison>(
      await fixture.compare({ evaluationRuleId: ruleId }),
      200,
    );
    expect(byRule).toMatchObject({
      status: 'ok',
      evaluationRuleId: ruleId,
      candidateRunId: automatedRuns[fixture.candidate.id],
      baselineRunId: automatedRuns[fixture.baseline.id],
    });
    const anyRun = await entity<EvaluationComparison>(await fixture.compare(), 200);
    expect(anyRun.candidateRunId).not.toBe(automatedRuns[fixture.candidate.id]);
  });

  it('基準aliasが未設定ならbaseline_missing、候補の評価がなければcandidate_not_evaluatedを返す', async () => {
    const fixture = await evaluationFixture(harness);
    expect(await entity<EvaluationComparison>(await fixture.compare(), 200)).toMatchObject({
      status: 'candidate_not_evaluated',
      candidateRunId: null,
      referenceDatasetVersionIds: [],
      codeVersionId: null,
      metrics: [],
    });
    await fixture.insertEvaluationRun({
      modelVersionId: fixture.candidate.id,
      inputs: [fixture.referenceA.id],
      latestMetrics: { accuracy: 0.9 },
    });
    const missing = await entity<EvaluationComparison>(
      await fixture.compare({ baselineAlias: 'staging' }),
      200,
    );
    expect(missing).toMatchObject({
      status: 'baseline_missing',
      baselineAlias: 'staging',
      baselineVersionId: null,
      referenceDatasetVersionIds: [fixture.referenceA.id],
    });
    expect(missing.metrics[0]).toMatchObject({ candidate: 0.9, baselineStatus: 'missing' });

    await fixture.insertEvaluationRun({
      modelVersionId: fixture.baseline.id,
      inputs: [fixture.referenceA.id],
      latestMetrics: { accuracy: 0.7 },
    });
    const byVersion = await entity<EvaluationComparison>(
      await fixture.compare({ baselineVersionId: fixture.baseline.id, metrics: 'accuracy,unknown' }),
      200,
    );
    expect(byVersion).toMatchObject({ status: 'ok', baselineAlias: null });
    expect(byVersion.metrics.map((metric) => metric.key)).toEqual(['accuracy', 'unknown']);
  });

  it('条件を指定すると候補の最新Runではなく、その条件の評価どうしを比べる', async () => {
    const fixture = await evaluationFixture(harness);
    for (const [version, accuracy] of [
      [fixture.candidate, 0.9],
      [fixture.baseline, 0.8],
    ] as const) {
      await fixture.insertEvaluationRun({
        modelVersionId: version.id,
        inputs: [fixture.referenceA.id],
        endedAt: '2026-10-01T00:00:00Z',
        latestMetrics: { accuracy },
      });
      await fixture.insertEvaluationRun({
        modelVersionId: version.id,
        inputs: [fixture.referenceB.id],
        endedAt: '2026-10-02T00:00:00Z',
        latestMetrics: { accuracy: accuracy / 2 },
      });
    }
    const comparison = await entity<EvaluationComparison>(
      await fixture.compare({ referenceDatasetVersionIds: fixture.referenceA.id }),
      200,
    );
    expect(comparison).toMatchObject({
      status: 'ok',
      referenceDatasetVersionIds: [fixture.referenceA.id],
    });
    expect(comparison.metrics[0]).toMatchObject({ candidate: 0.9, baseline: 0.8 });
  });

  it('正解セットのdigestを持つMLflowのDataset文脈付きの点を優先し、無いmetricはlatest_metricsを使う', async () => {
    const fixture = await evaluationFixture(harness);
    const inputs = [fixture.referenceA.id];
    const candidateRunId = await fixture.insertEvaluationRun({
      modelVersionId: fixture.candidate.id,
      inputs,
      latestMetrics: { accuracy: 0.2, loss: 0.4 },
    });
    await fixture.insertMetricPoint({
      runId: candidateRunId,
      name: 'accuracy',
      value: 0.7,
      step: 1,
      datasetDigest: fixture.referenceA.digest,
    });
    await fixture.insertMetricPoint({
      runId: candidateRunId,
      name: 'accuracy',
      value: 0.8,
      step: 2,
      datasetDigest: fixture.referenceA.digest,
    });
    // A later point on another dataset is what latest_metrics folded in; it must not win.
    await fixture.insertMetricPoint({
      runId: candidateRunId,
      name: 'accuracy',
      value: 0.2,
      step: 9,
      datasetDigest: fixture.referenceC.digest,
    });
    await fixture.insertEvaluationRun({
      modelVersionId: fixture.baseline.id,
      inputs,
      latestMetrics: { accuracy: 0.6, loss: 0.5 },
    });
    const comparison = await entity<EvaluationComparison>(await fixture.compare(), 200);
    expect(comparison.metrics).toEqual([
      expect.objectContaining({
        key: 'accuracy',
        candidate: 0.8,
        baseline: 0.6,
        source: { candidate: 'dataset_context', baseline: 'run_latest' },
      }),
      expect.objectContaining({
        key: 'loss',
        candidate: 0.4,
        source: { candidate: 'run_latest', baseline: 'run_latest' },
      }),
    ]);
  });

  it('NaNの評価値はnot_finiteとして返す', async () => {
    const fixture = await evaluationFixture(harness);
    const candidateRunId = await fixture.insertEvaluationRun({
      modelVersionId: fixture.candidate.id,
      inputs: [fixture.referenceA.id],
    });
    await fixture.insertMetricPoint({
      runId: candidateRunId,
      name: 'score',
      value: Number.NaN,
      step: 0,
      datasetDigest: fixture.referenceA.digest,
    });
    await fixture.insertEvaluationRun({
      modelVersionId: fixture.baseline.id,
      inputs: [fixture.referenceA.id],
      latestMetrics: { score: 1 },
    });
    const comparison = await entity<EvaluationComparison>(await fixture.compare(), 200);
    expect(comparison.metrics[0]).toMatchObject({
      key: 'score',
      candidate: null,
      candidateStatus: 'not_finite',
      delta: null,
    });
  });

  it('他Projectのバージョン・DatasetVersionは404、基準の二重指定は422にする', async () => {
    const fixture = await evaluationFixture(harness);
    const otherProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherPath = `/api/projects/${otherProject.id}`;
    const otherModel = await entity<{ id: string }>(
      await request(harness.app, `${otherPath}/models`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other', family: 'qwen2' },
      }),
    );
    const otherVersion = await entity<ModelVersion>(
      await request(harness.app, `${otherPath}/models/${otherModel.id}/versions`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { version: '1' },
      }),
    );
    const otherDataset = await entity<Dataset>(
      await request(harness.app, `${otherPath}/datasets`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other data' },
      }),
    );
    const otherDatasetVersion = await entity<DatasetVersion>(
      await request(harness.app, `${otherPath}/datasets/${otherDataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { version: '1', uri: 's3://other/1', digest: 'other' },
      }),
    );
    const viewer = { cookie: fixture.viewer.cookie };
    expect((await fixture.compare({}, { ...viewer, versionId: otherVersion.id })).status).toBe(404);
    expect((await fixture.compare({ baselineVersionId: otherVersion.id })).status).toBe(404);
    expect(
      (await fixture.compare({ referenceDatasetVersionIds: otherDatasetVersion.id })).status,
    ).toBe(404);
    expect(
      (
        await fixture.compare({
          baselineAlias: 'production',
          baselineVersionId: fixture.baseline.id,
        })
      ).status,
    ).toBe(422);
    expect((await fixture.compare({ referenceDatasetVersionIds: 'not-a-uuid' })).status).toBe(422);
  });

  it('viewerとreadトークンで読め、別Projectに限定したトークンと非メンバーは403になる', async () => {
    const fixture = await evaluationFixture(harness);
    const readToken = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { name: 'Read', kind: 'personal', projectId: fixture.project.id, scopes: ['read'] },
      }),
    );
    expect((await fixture.compare({}, { token: readToken.token })).status).toBe(200);

    const otherProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Token Project' },
      }),
    );
    const otherProjectToken = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other', kind: 'personal', projectId: otherProject.id, scopes: ['read'] },
      }),
    );
    expect((await fixture.compare({}, { token: otherProjectToken.token })).status).toBe(403);
    expect((await fixture.compare({}, { cookie: fixture.outsider.cookie })).status).toBe(403);
    expect((await fixture.compare({}, {})).status).toBe(401);
  });
});
