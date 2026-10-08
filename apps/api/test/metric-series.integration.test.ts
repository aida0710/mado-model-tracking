import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  MetricGroupsRequest,
  MetricGroupsResponse,
  MetricSeries,
  MetricSeriesRequest,
  MetricSeriesResponse,
  Project,
  Run,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { projectFixture } from './fixtures.js';

// A long training Run: the series endpoint has to stay interactive at this size.
const LONG_RUN_POINTS = 100_000;
// The acceptance budget for sampling one long series, measured inside the API process.
const SERIES_RESPONSE_BUDGET_MS = 1000;
const RUN_START = '2026-01-01T00:00:00.000Z';

type Fixture = Awaited<ReturnType<typeof projectFixture>>;
type Credentials = { cookie?: string; token?: string };

describe.skipIf(!testDatabaseUrl)('メトリクス系列の間引きとRunグループ（独立PostgreSQL）', () => {
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

  const postSeries = (
    body: Partial<MetricSeriesRequest>,
    credentials: Credentials = { cookie: fixture.viewer.cookie },
  ) =>
    request(harness.app, `${fixture.basePath}/metrics/series`, {
      method: 'POST',
      body: { xAxis: { kind: 'step' }, keys: ['loss'], ...body },
      ...credentials,
    });
  const readSeries = async (body: Partial<MetricSeriesRequest>) =>
    (await entity<MetricSeriesResponse>(await postSeries(body), 200)).series;
  const postGroups = (
    body: Partial<MetricGroupsRequest>,
    credentials: Credentials = { cookie: fixture.viewer.cookie },
  ) =>
    request(harness.app, `${fixture.basePath}/metrics/groups`, {
      method: 'POST',
      body: { xAxis: { kind: 'step' }, keys: ['loss'], ...body },
      ...credentials,
    });
  const readGroups = async (body: Partial<MetricGroupsRequest>) =>
    (await entity<MetricGroupsResponse>(await postGroups(body), 200)).groups;

  async function createRun(
    body: { name: string; tags?: Record<string, string>; parameters?: Record<string, string> },
    experimentId = fixture.experiment.id,
  ): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId, kind: 'training', ...body },
      }),
    );
  }
  /** Logs points through SQL; `value` may be 'NaN' or 'Infinity' as MLflow stores them. */
  async function insertPoints(
    runId: string,
    points: { name?: string; step: number; value: number | string; seconds?: number }[],
  ): Promise<void> {
    await harness.database.query(
      `INSERT INTO metrics(run_id,name,value,step,timestamp)
      SELECT $1,point.name,point.value::float8,point.step,
        timestamptz '${RUN_START}' + make_interval(secs => point.seconds)
      FROM jsonb_to_recordset($2::jsonb) AS point(name text,value text,step bigint,seconds float8)`,
      [
        runId,
        JSON.stringify(
          points.map((point) => ({
            name: point.name ?? 'loss',
            value: String(point.value),
            step: point.step,
            seconds: point.seconds ?? point.step,
          })),
        ),
      ],
    );
  }
  // A smooth curve between -1 and 1 with one spike up and one down that sampling must keep.
  async function insertLongRun(runId: string): Promise<void> {
    await harness.database.query(
      `INSERT INTO metrics(run_id,name,value,step,timestamp)
      SELECT $1,'loss',
        CASE n WHEN 54321 THEN 1000 WHEN 7777 THEN -1000 ELSE sin(n/1000.0) END,
        n,timestamptz '${RUN_START}' + make_interval(secs => n)
      FROM generate_series(0,$2-1) AS n`,
      [runId, LONG_RUN_POINTS],
    );
  }
  const onlySeries = (series: MetricSeries[]) => {
    expect(series).toHaveLength(1);
    return series[0]!;
  };

  it('10万点のRunはmaxPoints以下に間引かれ、スパイクがmin/maxに残り、1秒以内に返る', async () => {
    const run = await createRun({ name: 'long' });
    await insertLongRun(run.id);
    const startedAt = performance.now();
    const series = onlySeries(await readSeries({ runIds: [run.id], maxPoints: 1000 }));
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(SERIES_RESPONSE_BUDGET_MS);
    expect(series.sampled).toBe(true);
    expect(series.totalPoints).toBe(LONG_RUN_POINTS);
    expect(series.points.length).toBeLessThanOrEqual(1000);
    expect(series.points.length).toBeGreaterThan(990);
    expect(series.points.reduce((total, point) => total + point.count, 0)).toBe(LONG_RUN_POINTS);
    expect(Math.max(...series.points.map((point) => point.max))).toBe(1000);
    expect(Math.min(...series.points.map((point) => point.min))).toBe(-1000);
    const spike = series.points.find((point) => point.max === 1000)!;
    // The spike stays inside its bucket's range while the mean stays near the curve.
    expect(spike.value).toBeLessThan(20);
    expect(spike.step).toBeGreaterThanOrEqual(54321);
    // The last point of the Run lands in the last bucket, not past it.
    expect(series.points.at(-1)!.step).toBe(LONG_RUN_POINTS - 1);
    const steps = series.points.map((point) => point.step);
    expect(steps).toEqual([...steps].sort((left, right) => left - right));

    // Every x axis reads the same points; relative time once took minutes through a bad plan.
    for (const xAxis of [{ kind: 'relative_time' }, { kind: 'wall_time' }] as const) {
      const axisStartedAt = performance.now();
      const sampled = onlySeries(await readSeries({ runIds: [run.id], xAxis }));
      expect(performance.now() - axisStartedAt).toBeLessThan(SERIES_RESPONSE_BUDGET_MS);
      expect(sampled.points.length).toBeLessThanOrEqual(1000);
    }
  });

  it('点数がmaxPoints以下なら記録した点をそのまま返す', async () => {
    const run = await createRun({ name: 'short' });
    await insertPoints(run.id, [
      { step: 0, value: 2 },
      { step: 1, value: 1.5 },
      { step: 2, value: 1.25 },
    ]);
    const series = onlySeries(await readSeries({ runIds: [run.id], maxPoints: 3 }));
    expect(series).toEqual({
      runId: run.id,
      key: 'loss',
      sampled: false,
      totalPoints: 3,
      nanCount: 0,
      droppedPoints: 0,
      points: [
        { x: 0, step: 0, value: 2, min: 2, max: 2, count: 1 },
        { x: 1, step: 1, value: 1.5, min: 1.5, max: 1.5, count: 1 },
        { x: 2, step: 2, value: 1.25, min: 1.25, max: 1.25, count: 1 },
      ],
    });
    // A Run without the key still answers, with an empty series.
    const missing = onlySeries(await readSeries({ runIds: [run.id], keys: ['accuracy'] }));
    expect(missing).toMatchObject({ points: [], totalPoints: 0, sampled: false });
  });

  it('x=relative_timeは開始時刻（無ければ最初の点）からの秒、x=wall_timeはepochミリ秒', async () => {
    const started = await createRun({ name: 'started' });
    await harness.database.query('UPDATE runs SET started_at=$2 WHERE id=$1', [
      started.id,
      '2025-12-31T23:59:58.000Z',
    ]);
    await insertPoints(started.id, [
      { step: 0, value: 1, seconds: 1.5 },
      { step: 1, value: 2, seconds: 3 },
    ]);
    const neverStarted = await createRun({ name: 'never-started' });
    // The first point of any key is the origin, not the first point of the requested key.
    await insertPoints(neverStarted.id, [
      { name: 'lr', step: 0, value: 0.1, seconds: 10 },
      { step: 0, value: 1, seconds: 12 },
      { step: 1, value: 2, seconds: 15.25 },
    ]);
    const relative = await readSeries({
      runIds: [started.id, neverStarted.id],
      xAxis: { kind: 'relative_time' },
    });
    expect(relative.map((series) => series.points.map((point) => point.x))).toEqual([
      [3.5, 5],
      [2, 5.25],
    ]);
    const wall = onlySeries(
      await readSeries({ runIds: [started.id], xAxis: { kind: 'wall_time' } }),
    );
    const runStart = Date.parse(RUN_START);
    expect(wall.points.map((point) => point.x)).toEqual([runStart + 1500, runStart + 3000]);
  });

  it('x=metricは同じstepの最後の値をxにし、xの無い点は落として件数を返す', async () => {
    const run = await createRun({ name: 'metric-axis' });
    await insertPoints(run.id, [
      ...[0, 1, 2, 3, 4].map((step) => ({ step, value: 10 - step })),
      { name: 'epoch', step: 0, value: 0.5, seconds: 0 },
      { name: 'epoch', step: 1, value: 0.9, seconds: 1 },
      // A later write at the same step replaces the earlier x.
      { name: 'epoch', step: 1, value: 1, seconds: 2 },
      { name: 'epoch', step: 2, value: 'NaN', seconds: 2 },
      { name: 'epoch', step: 3, value: 3, seconds: 3 },
    ]);
    const series = onlySeries(
      await readSeries({ runIds: [run.id], xAxis: { kind: 'metric', metricKey: 'epoch' } }),
    );
    expect(series.points.map((point) => [point.x, point.step, point.value])).toEqual([
      [0.5, 0, 10],
      [1, 1, 9],
      [3, 3, 7],
    ]);
    // Step 2 has a NaN x and step 4 none at all.
    expect(series.droppedPoints).toBe(2);
    expect(series.totalPoints).toBe(3);
  });

  it('xRangeで拡大するとその範囲だけを細かいbucketに分ける', async () => {
    const run = await createRun({ name: 'zoom' });
    await insertLongRun(run.id);
    const overview = onlySeries(await readSeries({ runIds: [run.id], maxPoints: 100 }));
    const zoomed = onlySeries(
      await readSeries({ runIds: [run.id], maxPoints: 100, xRange: { min: 0, max: 9999 } }),
    );
    expect(overview.points[0]!.count).toBe(1000);
    expect(zoomed.totalPoints).toBe(10000);
    expect(zoomed.points).toHaveLength(100);
    expect(zoomed.points.every((point) => point.count === 100)).toBe(true);
    expect(zoomed.points.at(-1)!.step).toBe(9999);
    // The spike at step 7777 is inside the zoomed range and survives there too.
    expect(Math.min(...zoomed.points.map((point) => point.min))).toBe(-1000);

    const raw = onlySeries(
      await readSeries({ runIds: [run.id], maxPoints: 1000, xRange: { min: 500, max: 1499 } }),
    );
    expect(raw).toMatchObject({ sampled: false, totalPoints: 1000 });
    expect(raw.points[0]).toMatchObject({ x: 500, count: 1 });
  });

  it('NaNと無限大は集約から除き、nanCountで件数を返す', async () => {
    const run = await createRun({ name: 'nan' });
    await insertPoints(run.id, [
      { step: 0, value: 1 },
      { step: 1, value: 'NaN' },
      { step: 2, value: 3 },
      { step: 3, value: 'Infinity' },
      ...[0, 1].map((step) => ({ name: 'diverged', step, value: 'NaN' })),
    ]);
    const [loss, diverged] = await readSeries({ runIds: [run.id], keys: ['loss', 'diverged'] });
    expect(loss!.points.map((point) => point.value)).toEqual([1, 3]);
    expect(loss).toMatchObject({ nanCount: 2, totalPoints: 4 });
    expect(diverged).toMatchObject({ points: [], nanCount: 2, totalPoints: 2 });
    // Sampled buckets leave the NaN out of the mean as well.
    const sampled = onlySeries(await readSeries({ runIds: [run.id], maxPoints: 1 }));
    expect(sampled.points).toEqual([{ x: 1, step: 2, value: 2, min: 1, max: 3, count: 2 }]);
    expect(sampled.nanCount).toBe(2);
  });

  it('tagのグループごとに、Runごとのbucket平均からRun間の平均・min・max・stddevを出す', async () => {
    const adam = await Promise.all(
      ['adam-1', 'adam-2', 'adam-3'].map((name) =>
        createRun({ name, tags: { optimizer: 'adam' } }),
      ),
    );
    const sgd = await Promise.all(
      ['sgd-1', 'sgd-2', 'sgd-3'].map((name) => createRun({ name, tags: { optimizer: 'sgd' } })),
    );
    const untagged = await createRun({ name: 'untagged' });
    const steps = (values: number[]) => values.map((value, step) => ({ step, value }));
    await insertPoints(adam[0]!.id, steps([1, 2, 3]));
    await insertPoints(adam[1]!.id, steps([3, 4, 5]));
    // Two points at step 1 are averaged inside the Run before Runs are combined.
    await insertPoints(adam[2]!.id, [...steps([5, 6]), { step: 1, value: 8, seconds: 1.5 }]);
    for (const run of sgd) await insertPoints(run.id, steps([10, 20, 30]));
    await insertPoints(untagged.id, steps([7, 7, 7]));

    const groups = await readGroups({
      runIds: [...adam, ...sgd, untagged].map((run) => run.id),
      groupBy: { kind: 'tag', key: 'optimizer' },
      maxPoints: 3,
    });
    expect(groups.map((group) => [group.groupKey, group.label, group.runIds.length])).toEqual([
      ['adam', 'adam', 3],
      ['sgd', 'sgd', 3],
      ['(none)', '(none)', 1],
    ]);
    const adamPoints = groups[0]!.series[0]!.points;
    const stddev = (values: number[]) => {
      const mean = values.reduce((total, value) => total + value, 0) / values.length;
      return Math.sqrt(
        values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length,
      );
    };
    expect(adamPoints.map((point) => point.x)).toEqual([0, 1, 2]);
    expect(adamPoints.map((point) => point.runCount)).toEqual([3, 3, 2]);
    expect(adamPoints[0]).toMatchObject({ mean: 3, min: 1, max: 5 });
    expect(adamPoints[0]!.stddev).toBeCloseTo(stddev([1, 3, 5]), 12);
    expect(adamPoints[1]!.mean).toBeCloseTo(13 / 3, 12);
    expect(adamPoints[1]).toMatchObject({ min: 2, max: 7 });
    expect(adamPoints[1]!.stddev).toBeCloseTo(stddev([2, 4, 7]), 12);
    // The third adam Run has no value at step 2 and is not counted there.
    expect(adamPoints[2]).toMatchObject({ mean: 4, min: 3, max: 5, runCount: 2 });
    expect(adamPoints[2]!.stddev).toBeCloseTo(1, 12);
    expect(groups[1]!.series[0]!.points.map((point) => [point.mean, point.stddev])).toEqual([
      [10, 0],
      [20, 0],
      [30, 0],
    ]);
    expect(groups[2]!.series[0]!.points.map((point) => point.mean)).toEqual([7, 7, 7]);

    // search selects the same Runs through the run search filter.
    const searched = await readGroups({
      search: { filter: "tags.optimizer = 'adam'" },
      groupBy: { kind: 'tag', key: 'optimizer' },
      maxPoints: 3,
    });
    expect(searched.map((group) => group.groupKey)).toEqual(['adam']);
    expect(searched[0]!.series).toEqual(groups[0]!.series);
  });

  it('paramは記録値を優先して合成し、ExperimentはnameをlabelにしてRunを分ける', async () => {
    const recorded = await createRun({ name: 'recorded', parameters: { lr: '0.1' } });
    await harness.database.query(
      `UPDATE runs SET recorded_parameters='{"lr":"0.01"}'::jsonb WHERE id=$1`,
      [recorded.id],
    );
    const executed = await createRun({ name: 'executed', parameters: { lr: '0.001' } });
    const second = await entity<{ id: string }>(
      await request(harness.app, `${fixture.basePath}/experiments`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Ablation' },
      }),
    );
    const ablation = await createRun({ name: 'ablation' }, second.id);
    for (const run of [recorded, executed, ablation])
      await insertPoints(run.id, [{ step: 0, value: 1 }]);
    const runIds = [recorded.id, executed.id, ablation.id];

    const byParam = await readGroups({ runIds, groupBy: { kind: 'param', key: 'lr' } });
    expect(byParam.map((group) => [group.groupKey, group.runIds])).toEqual([
      ['0.001', [executed.id]],
      ['0.01', [recorded.id]],
      ['(none)', [ablation.id]],
    ]);
    const byExperiment = await readGroups({ runIds, groupBy: { kind: 'experiment' } });
    expect(byExperiment.map((group) => [group.groupKey, group.label, group.runIds])).toEqual([
      [second.id, 'Ablation', [ablation.id]],
      [fixture.experiment.id, 'Test Experiment', [recorded.id, executed.id]],
    ]);
  });

  it('searchの一致が1000件を超えると422 too_many_runsになる', async () => {
    await harness.database.query(
      `INSERT INTO runs(project_id,experiment_id,name,kind,created_by)
      SELECT $1,$2,'bulk-'||n,'training',$3 FROM generate_series(1,1001) AS n`,
      [fixture.project.id, fixture.experiment.id, fixture.editor.userId],
    );
    const response = await postGroups({ search: {}, groupBy: { kind: 'experiment' } });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('too_many_runs');
    // A search matching nothing has no groups.
    expect(
      await readGroups({ search: { name: 'no-such-run' }, groupBy: { kind: 'experiment' } }),
    ).toEqual([]);
  });

  it('他ProjectのRunが混じると404で、存在を区別しない', async () => {
    const own = await createRun({ name: 'own' });
    const foreignProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { name: 'Foreign Project' },
      }),
    );
    const foreignExperiment = await entity<{ id: string }>(
      await request(harness.app, `/api/projects/${foreignProject.id}/experiments`, {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { name: 'Foreign Experiment' },
      }),
    );
    const foreign = await entity<Run>(
      await request(harness.app, `/api/projects/${foreignProject.id}/runs`, {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { experimentId: foreignExperiment.id, kind: 'training', name: 'foreign' },
      }),
    );
    await insertPoints(foreign.id, [{ step: 0, value: 1 }]);
    const runIds = [own.id, foreign.id];
    const missingRunId = '00000000-0000-4000-8000-000000000000';
    for (const response of [
      await postSeries({ runIds }),
      await postSeries({ runIds: [own.id, missingRunId] }),
      await postGroups({ runIds, groupBy: { kind: 'experiment' } }),
    ]) {
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('not_found');
    }
  });

  it('viewerは読め、read scopeの無いtoken・他Project限定token・非メンバーは403', async () => {
    const run = await createRun({ name: 'permissions' });
    await insertPoints(run.id, [{ step: 0, value: 1 }]);
    const mintToken = async (
      body: { projectId: string; scopes: string[] },
      owner: { cookie: string } = fixture.viewer,
    ) =>
      (
        await entity<{ token: string }>(
          await request(harness.app, '/api/tokens', {
            method: 'POST',
            cookie: owner.cookie,
            body: { name: 'Metric series test', kind: 'personal', ...body },
          }),
        )
      ).token;
    const readable = await mintToken({ projectId: fixture.project.id, scopes: ['read'] });
    expect((await postSeries({ runIds: [run.id] }, { token: readable })).status).toBe(200);
    const groupBy = { kind: 'experiment' } as const;
    expect((await postGroups({ runIds: [run.id], groupBy }, { token: readable })).status).toBe(200);

    // A viewer may not mint write tokens, so an editor's write-only token checks the scope.
    const writeOnly = await mintToken(
      { projectId: fixture.project.id, scopes: ['runs:write'] },
      fixture.editor,
    );
    for (const response of [
      await postSeries({ runIds: [run.id] }, { token: writeOnly }),
      await postGroups({ runIds: [run.id], groupBy }, { token: writeOnly }),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('insufficient_scope');
    }
    const otherProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { name: 'Viewer Project' },
      }),
    );
    const restricted = await mintToken({ projectId: otherProject.id, scopes: ['read'] });
    expect((await postSeries({ runIds: [run.id] }, { token: restricted })).status).toBe(403);
    expect(
      (await postSeries({ runIds: [run.id] }, { cookie: fixture.outsider.cookie })).status,
    ).toBe(403);
  });

  it('上限と組み合わせの誤りは422で拒む', async () => {
    const run = await createRun({ name: 'validation' });
    const rejected = [
      await postSeries({ runIds: [run.id], xAxis: { kind: 'metric' } }),
      await postSeries({ runIds: [run.id], xAxis: { kind: 'step', metricKey: 'epoch' } }),
      await postSeries({ runIds: [run.id], maxPoints: 5001 }),
      await postSeries({ runIds: [run.id, run.id] }),
      await postSeries({ runIds: [] }),
      await postSeries({ runIds: [run.id], xRange: { min: 2, max: 2 } }),
      await postGroups({ groupBy: { kind: 'experiment' } }),
      await postGroups({ runIds: [run.id], search: {}, groupBy: { kind: 'experiment' } }),
      await postGroups({ runIds: [run.id], groupBy: { kind: 'tag' } }),
      await postGroups({ search: { limit: 10 }, groupBy: { kind: 'experiment' } } as never),
    ];
    for (const response of rejected) {
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('invalid_request');
    }
  });
});
