import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ANALYSIS_MAX_RUNS,
  type JsonValue,
  type ParameterImportanceRequest,
  type ParameterImportanceResult,
  type Project,
  type RunAnalysisTableRequest,
  type RunAnalysisTableResponse,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { projectFixture } from './fixtures.js';
import { sweepFixture } from './sweepFixtures.js';

// Enough Runs for the forest to separate a strong, a weak and an irrelevant parameter.
const SYNTHETIC_RUN_COUNT = 30;

type Fixture = Awaited<ReturnType<typeof projectFixture>>;
type Credentials = { cookie?: string; token?: string };
interface SeededRun {
  name: string;
  parameters?: Record<string, JsonValue>;
  recordedParameters?: Record<string, string>;
  latestMetrics?: Record<string, number | string>;
}

describe.skipIf(!testDatabaseUrl)('探索結果の分析API（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  const postTable = (
    body: RunAnalysisTableRequest,
    credentials: Credentials = { cookie: fixture.viewer.cookie },
    basePath = fixture.basePath,
  ) =>
    request(harness.app, `${basePath}/runs/analysis/table`, {
      method: 'POST',
      body,
      ...credentials,
    });
  const readTable = async (body: RunAnalysisTableRequest) =>
    entity<RunAnalysisTableResponse>(await postTable(body), 200);
  const postImportance = (
    body: ParameterImportanceRequest,
    credentials: Credentials = { cookie: fixture.viewer.cookie },
    basePath = fixture.basePath,
  ) =>
    request(harness.app, `${basePath}/runs/analysis/parameter-importance`, {
      method: 'POST',
      body,
      ...credentials,
    });
  const readImportance = async (body: ParameterImportanceRequest) =>
    entity<ParameterImportanceResult>(await postImportance(body), 200);

  /** Inserts finished Runs through SQL, oldest first; returns their IDs in the same order. */
  async function seedRuns(runs: SeededRun[]): Promise<string[]> {
    const inserted = await harness.database.query<{ id: string }>(
      `INSERT INTO runs(project_id,experiment_id,name,kind,status,parameters,recorded_parameters,
        latest_metrics,created_by,created_at)
      SELECT $1,$2,run.value->>'name','training','finished',run.value->'parameters',
        run.value->'recorded_parameters',run.value->'latest_metrics',$3,
        now() - make_interval(secs => $5 - run.position::int)
      FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS run(value,position)
      ORDER BY run.position
      RETURNING id`,
      [
        fixture.project.id,
        fixture.experiment.id,
        fixture.editor.userId,
        JSON.stringify(
          runs.map((run) => ({
            name: run.name,
            parameters: run.parameters ?? {},
            recorded_parameters: run.recordedParameters ?? {},
            latest_metrics: run.latestMetrics ?? {},
          })),
        ),
        runs.length + 1,
      ],
    );
    return inserted.rows.map((row) => row.id);
  }

  /**
   * loss depends strongly on lr, weakly on optimizer and not at all on noise. lr arrives as an
   * SDK-recorded string, as MLflow logs params.
   */
  function syntheticRuns(): SeededRun[] {
    return Array.from({ length: SYNTHETIC_RUN_COUNT }, (_, index) => {
      const lr = (index % 10) / 10;
      const optimizer = index % 3 === 0 ? 'sgd' : 'adam';
      return {
        name: `trial-${index}`,
        parameters: { optimizer, noise: (index * 7) % 11, lr: 999 },
        recordedParameters: { lr: String(lr) },
        latestMetrics: { loss: 10 * lr + (optimizer === 'sgd' ? 3 : 0), accuracy: 1 - lr },
      };
    });
  }

  async function createProject(name: string): Promise<Project> {
    return entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name },
      }),
    );
  }

  it('30件の合成データで重要度はlr、optimizer、noiseの順になる', async () => {
    const runIds = await seedRuns(syntheticRuns());
    const result = await readImportance({ runSet: { runIds }, targetMetric: 'loss' });

    expect(result).toMatchObject({
      targetMetric: 'loss',
      targetSource: 'latest_metric',
      runCount: SYNTHETIC_RUN_COUNT,
      skippedRunCount: 0,
      excluded: [],
      importanceUnavailableReason: null,
    });
    expect(result.entries.map((entry) => entry.param)).toEqual(['lr', 'optimizer', 'noise']);
    const lr = result.entries[0]!;
    // The recorded string wins over the execution value 999, and is read as a number.
    expect(lr).toMatchObject({ kind: 'numeric', coverage: 1 });
    expect(lr.correlation).toBeGreaterThan(0.8);
    expect(lr.importance).toBeGreaterThan(0.5);
    expect(result.entries[1]).toMatchObject({ param: 'optimizer', kind: 'categorical' });
    // A fixed seed gives the same answer twice.
    expect(await readImportance({ runSet: { runIds }, targetMetric: 'loss' })).toEqual(result);
  });

  it('search経由とrunIds経由は、runIdsの順に関係なく同じ結果になる', async () => {
    const runIds = await seedRuns(syntheticRuns());
    await seedRuns([{ name: 'other-1', latestMetrics: { loss: 100 }, parameters: { lr: 5 } }]);

    const bySearch = await readImportance({
      runSet: { search: { name: 'trial-' } },
      targetMetric: 'loss',
    });
    const byIds = await readImportance({
      runSet: { runIds: [...runIds].reverse() },
      targetMetric: 'loss',
    });
    expect(bySearch).toEqual(byIds);
    expect(bySearch.runCount).toBe(SYNTHETIC_RUN_COUNT);

    const tableBySearch = await readTable({
      runSet: { search: { name: 'trial-' } },
      metrics: ['loss'],
    });
    const tableByIds = await readTable({ runSet: { runIds }, metrics: ['loss'] });
    expect(tableBySearch).toEqual(tableByIds);
  });

  it('表はparams×metricsを返し、カテゴリparamはvalues一覧を持ち、metricsは範囲と非有限値のnullを返す', async () => {
    const [first, second, third] = await seedRuns([
      {
        name: 'a',
        parameters: { optimizer: 'sgd', layers: 2, flags: { dropout: true } },
        latestMetrics: { loss: 0.5, accuracy: 0.8 },
      },
      {
        name: 'b',
        parameters: { optimizer: 'adam', layers: '4' },
        latestMetrics: { loss: 'NaN', accuracy: 0.9 },
      },
      { name: 'c', parameters: { optimizer: 'adamw', layers: 8, unused: null }, latestMetrics: {} },
    ]);
    const table = await readTable({
      runSet: { runIds: [first!, second!, third!] },
      metrics: ['loss', 'accuracy', 'missing'],
    });

    // Newest first, as the Run list orders them.
    expect(table.runs.map((run) => run.name)).toEqual(['c', 'b', 'a']);
    expect(table.runs[2]).toEqual({
      runId: first,
      name: 'a',
      experimentId: fixture.experiment.id,
      status: 'finished',
      params: { optimizer: 'sgd', layers: 2, flags: { dropout: true } },
      metrics: { loss: 0.5, accuracy: 0.8 },
    });
    expect(table.runs[1]!.metrics).toEqual({ loss: null, accuracy: 0.9 });
    expect(table.runs[0]!.metrics).toEqual({});
    // A null param is no value, so it is neither shown nor selected.
    expect(table.runs[0]!.params).toEqual({ optimizer: 'adamw', layers: 8 });
    expect(table.params).toEqual([
      { key: 'flags', kind: 'categorical', values: ['{"dropout":true}'], coverage: 1 / 3 },
      { key: 'layers', kind: 'numeric', coverage: 1 },
      { key: 'optimizer', kind: 'categorical', values: ['adam', 'adamw', 'sgd'], coverage: 1 },
    ]);
    expect(table.metrics).toEqual([
      { key: 'loss', min: 0.5, max: 0.5 },
      { key: 'accuracy', min: 0.8, max: 0.9 },
      { key: 'missing', min: null, max: null },
    ]);
    expect(table.objective).toBeUndefined();

    const chosen = await readTable({
      runSet: { runIds: [first!, second!] },
      params: ['layers', 'absent'],
      metrics: ['loss'],
    });
    expect(chosen.params).toEqual([
      { key: 'layers', kind: 'numeric', coverage: 1 },
      { key: 'absent', kind: 'numeric', coverage: 0 },
    ]);
    expect(chosen.runs.map((run) => run.params)).toEqual([{ layers: '4' }, { layers: 2 }]);
  });

  it('params省略時、101個以上あればcoverageの高い順に100個を名前順で返す', async () => {
    // p000 has a value in both Runs, p001-p100 only in the first: 101 params, one must go.
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`p${String(index).padStart(3, '0')}`, index]),
    );
    const runIds = await seedRuns([
      { name: 'wide', parameters: many },
      { name: 'narrow', parameters: { p000: 1, p100: 2 } },
    ]);
    const table = await readTable({ runSet: { runIds }, metrics: ['loss'] });
    const keys = table.params.map((param) => param.key);
    expect(keys).toHaveLength(100);
    // p000 and p100 are covered by both; of the rest the last name in order (p099) drops out.
    expect(keys).toContain('p100');
    expect(keys).not.toContain('p099');
    expect(keys).toEqual([...keys].sort());
  });

  it('5001件は422 too_many_runsになる（runIds・search）。一致0件のsearchは空の表を返す', async () => {
    const tooManyIds = Array.from({ length: ANALYSIS_MAX_RUNS + 1 }, () => randomUUID());
    const byIds = await postTable({ runSet: { runIds: tooManyIds }, metrics: ['loss'] });
    expect(byIds.status).toBe(422);
    expect((await byIds.json()).code).toBe('too_many_runs');

    await harness.database.query(
      `INSERT INTO runs(project_id,experiment_id,name,kind,created_by)
      SELECT $1,$2,'bulk-'||n,'training',$3 FROM generate_series(1,$4) AS n`,
      [fixture.project.id, fixture.experiment.id, fixture.editor.userId, ANALYSIS_MAX_RUNS + 1],
    );
    const bySearch = await postImportance({ runSet: { search: {} }, targetMetric: 'loss' });
    expect(bySearch.status).toBe(422);
    expect((await bySearch.json()).code).toBe('too_many_runs');

    const empty = await readTable({
      runSet: { search: { name: 'no-such-run' } },
      metrics: ['loss'],
    });
    expect(empty).toEqual({
      runs: [],
      params: [],
      metrics: [{ key: 'loss', min: null, max: null }],
    });
  });

  it('runSetでない入力、targetMetricの欠落は422になる', async () => {
    const [runId] = await seedRuns([{ name: 'a' }]);
    for (const runSet of [{}, { runIds: [runId], sweepId: randomUUID() }, { runIds: [] }]) {
      const response = await postTable({ runSet, metrics: ['loss'] } as RunAnalysisTableRequest);
      expect(response.status).toBe(422);
    }
    const missingTarget = await postImportance({ runSet: { runIds: [runId!] } });
    expect(missingTarget.status).toBe(422);
    expect((await missingTarget.json()).code).toBe('target_metric_required');
  });

  it('他Projectのrunを混ぜると404、非メンバーとread scopeの無いtokenは403', async () => {
    const [ownRunId] = await seedRuns([{ name: 'own' }]);
    const otherProject = await createProject('Other Project');
    const otherExperiment = await entity<{ id: string }>(
      await request(harness.app, `/api/projects/${otherProject.id}/experiments`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Experiment' },
      }),
    );
    const foreign = await harness.database.query<{ id: string }>(
      `INSERT INTO runs(project_id,experiment_id,name,kind,created_by)
      VALUES($1,$2,'foreign','training',$3) RETURNING id`,
      [otherProject.id, otherExperiment.id, fixture.administrator.userId],
    );
    const mixed = { runIds: [ownRunId!, foreign.rows[0]!.id] };
    expect((await postTable({ runSet: mixed, metrics: ['loss'] })).status).toBe(404);
    expect((await postImportance({ runSet: mixed, targetMetric: 'loss' })).status).toBe(404);

    const body = { runSet: { runIds: [ownRunId!] }, metrics: ['loss'] };
    expect((await postTable(body, { cookie: fixture.outsider.cookie })).status).toBe(403);
    const mintToken = async (tokenBody: { projectId: string; scopes: string[] }) =>
      (
        await entity<{ token: string }>(
          await request(harness.app, '/api/tokens', {
            method: 'POST',
            cookie: fixture.administrator.cookie,
            body: { name: 'Run analysis test', kind: 'personal', ...tokenBody },
          }),
        )
      ).token;
    const readable = await mintToken({ projectId: fixture.project.id, scopes: ['read'] });
    expect((await postTable(body, { token: readable })).status).toBe(200);
    const writeOnly = await mintToken({ projectId: fixture.project.id, scopes: ['runs:write'] });
    expect((await postTable(body, { token: writeOnly })).status).toBe(403);
    expect(
      (await postImportance({ runSet: body.runSet, targetMetric: 'loss' }, { token: writeOnly }))
        .status,
    ).toBe(403);
    const restricted = await mintToken({ projectId: otherProject.id, scopes: ['read'] });
    expect((await postTable(body, { token: restricted })).status).toBe(403);
  });
});

describe.skipIf(!testDatabaseUrl)('Sweepの分析（独立PostgreSQL）', () => {
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

  it('sweepIdで試行のparametersとobjectiveが出て、重要度の既定の対象はobjectiveになる。他Projectのsweepは404', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'grid',
      method: 'grid',
      searchSpace: { lr: { values: [0.1, 0.01] }, batch: { values: [16, 32] } },
      objective: { metric: 'loss', goal: 'minimize', aggregation: 'min' },
      maxTrials: 4,
      parallelism: 4,
    });
    const claimed = await fixture.claimAll();
    expect(claimed).toHaveLength(4);
    const trials = await fixture.listTrials(sweep.id);
    for (const job of claimed) {
      const trial = trials.find((candidate) => candidate.runId === job.run.id)!;
      const lr = trial.parameters.lr as number;
      // The minimum (the objective) comes before the last value (the latest metric).
      await fixture.logMetric(job, [
        { name: 'loss', value: lr, step: 1 },
        { name: 'loss', value: lr + 1, step: 2 },
      ]);
      await fixture.complete(job);
    }

    const table = await entity<RunAnalysisTableResponse>(
      await request(harness.app, `${fixture.basePath}/runs/analysis/table`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { runSet: { sweepId: sweep.id }, params: ['lr', 'batch'], metrics: ['loss'] },
      }),
      200,
    );
    expect(table.runs.map((run) => run.sweepTrialIndex)).toEqual([0, 1, 2, 3]);
    expect(table.runs.map((run) => run.params)).toEqual(trials.map((trial) => trial.parameters));
    for (const run of table.runs) {
      const lr = run.params.lr as number;
      expect(run.objective).toBe(lr);
      expect(run.metrics.loss).toBe(lr + 1);
    }
    expect(table.params).toEqual([
      { key: 'lr', kind: 'numeric', coverage: 1 },
      { key: 'batch', kind: 'numeric', coverage: 1 },
    ]);
    expect(table.objective).toEqual({
      metric: 'loss',
      goal: 'minimize',
      aggregation: 'min',
      min: 0.01,
      max: 0.1,
    });

    const importance = await entity<ParameterImportanceResult>(
      await request(harness.app, `${fixture.basePath}/runs/analysis/parameter-importance`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { runSet: { sweepId: sweep.id }, params: ['lr', 'batch'] },
      }),
      200,
    );
    expect(importance).toMatchObject({
      targetMetric: 'loss',
      targetSource: 'sweep_objective',
      runCount: 4,
      // Four trials are below the minimum for the forest; correlations are still returned.
      importanceUnavailableReason: 'too_few_runs',
    });
    expect(importance.entries[0]).toMatchObject({ param: 'lr', correlation: 1 });

    // A Run of the sweep through runIds carries its trial index but no objective.
    const byIds = await entity<RunAnalysisTableResponse>(
      await request(harness.app, `${fixture.basePath}/runs/analysis/table`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { runSet: { runIds: [trials[0]!.runId] }, metrics: ['loss'] },
      }),
      200,
    );
    expect(byIds.runs[0]!.sweepTrialIndex).toBe(0);
    expect(byIds.runs[0]).not.toHaveProperty('objective');
    expect(byIds.objective).toBeUndefined();

    const otherProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const foreign = await request(
      harness.app,
      `/api/projects/${otherProject.id}/runs/analysis/table`,
      {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { runSet: { sweepId: sweep.id }, metrics: ['loss'] },
      },
    );
    expect(foreign.status).toBe(404);
  });
});
