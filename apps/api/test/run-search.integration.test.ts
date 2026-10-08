import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Experiment, Run, RunSearchPage, RunSearchRequest } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { projectFixture } from './fixtures.js';
import { trackingClient, trackingTestApp, type WireRun } from './mlflow-tracking-fixtures.js';

// More than the 500 Runs the previous browser-side list could hold.
const HISTORY_RUN_COUNT = 650;

type Fixture = Awaited<ReturnType<typeof projectFixture>>;

describe.skipIf(!testDatabaseUrl)('全履歴のRun検索（独立PostgreSQL）', () => {
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

  const searchRuns = (
    body: RunSearchRequest,
    credentials: { cookie?: string; token?: string } = { cookie: fixture.viewer.cookie },
    projectId = fixture.project.id,
  ) =>
    request(harness.app, `/api/projects/${projectId}/runs/search`, {
      method: 'POST',
      body,
      ...credentials,
    });
  const searchPage = async (body: RunSearchRequest) =>
    entity<RunSearchPage>(await searchRuns(body), 200);
  async function collectAllPages(body: RunSearchRequest, beforeEachPage?: () => Promise<void>) {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      await beforeEachPage?.();
      const page = await searchPage({ ...body, ...(cursor ? { cursor } : {}) });
      names.push(...page.items.map((run) => run.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return names;
  }
  async function createRun(body: Record<string, unknown>): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, kind: 'training', ...body },
      }),
    );
  }
  // Bulk history goes straight to SQL; creating hundreds of Runs over HTTP adds no coverage.
  async function insertHistory(
    count: number,
    options: { firstSecond: number; prefix: string },
  ): Promise<void> {
    await harness.database.query(
      `INSERT INTO runs(project_id,experiment_id,name,kind,created_by,created_at,parameters,latest_metrics)
      SELECT $1,$2,$3||lpad(n::text,4,'0'),'training',$4,
        timestamptz '2026-01-01T00:00:00Z' + make_interval(secs => $5 + n),
        jsonb_build_object('seed',n),jsonb_build_object('loss',n)
      FROM generate_series(1,$6) AS n`,
      [
        fixture.project.id,
        fixture.experiment.id,
        options.prefix,
        fixture.editor.userId,
        options.firstSecond,
        count,
      ],
    );
  }

  it('600件を超える履歴でも最古のRunをmetrics・params条件で見つける', async () => {
    const oldest = await createRun({ name: 'oldest-run', parameters: { optimizer: 'lion' } });
    await harness.database.query(
      "UPDATE runs SET created_at=timestamptz '2025-01-01T00:00:00Z' WHERE id=$1",
      [oldest.id],
    );
    const logged = await request(harness.app, `${fixture.basePath}/runs/${oldest.id}/metrics`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        metrics: [{ name: 'val/loss', value: 0.01, step: 1, timestamp: new Date().toISOString() }],
      },
    });
    expect(logged.status).toBe(204);
    await insertHistory(HISTORY_RUN_COUNT, { firstSecond: 0, prefix: 'history-' });

    const page = await searchPage({
      filter: "metrics.`val/loss` < 0.05 AND params.optimizer = 'lion'",
    });
    expect(page.items.map((run) => run.name)).toEqual(['oldest-run']);
    expect(page.nextCursor).toBeNull();
    // Polling summaries keep execution identity without the snapshot body.
    expect(page.items[0]).not.toHaveProperty('executionSnapshot');
    expect(page.items[0]!.parameters).toEqual({ optimizer: 'lion' });

    const byName = await searchPage({ name: 'OLDEST' });
    expect(byName.items.map((run) => run.id)).toEqual([oldest.id]);
    // LIKE wildcards in the name are matched literally.
    expect((await searchPage({ name: '%' })).items).toEqual([]);
  });

  it('既定順のcursorで全件を重複・欠落なく辿り、途中で作られたRunでずれない', async () => {
    await insertHistory(HISTORY_RUN_COUNT, { firstSecond: 0, prefix: 'history-' });
    let pagesRead = 0;
    const names = await collectAllPages({ limit: 100 }, async () => {
      // A Run created while paging belongs before page one and must not shift later pages.
      if (pagesRead++ === 2) await createRun({ name: 'created-while-paging' });
    });
    expect(names).toHaveLength(HISTORY_RUN_COUNT);
    expect(new Set(names).size).toBe(HISTORY_RUN_COUNT);
    expect(names[0]).toBe('history-0650');
    expect(names.at(-1)).toBe('history-0001');
    expect(names).not.toContain('created-while-paging');
  });

  it('同じ作成時刻のRunもIDで順序を決め、境界で重複・欠落しない', async () => {
    await harness.database.query(
      `INSERT INTO runs(project_id,experiment_id,name,kind,created_by,created_at)
      SELECT $1,$2,'same-time-'||n,'training',$3,timestamptz '2026-02-01T00:00:00Z'
      FROM generate_series(1,7) AS n`,
      [fixture.project.id, fixture.experiment.id, fixture.editor.userId],
    );
    const names = await collectAllPages({ limit: 3 });
    expect(new Set(names).size).toBe(7);
  });

  it('orderByのoffset cursorで全件を辿り、条件を変えたcursorは400で拒否する', async () => {
    await insertHistory(120, { firstSecond: 0, prefix: 'history-' });
    const ordered = { orderBy: ['metrics.loss ASC'], limit: 50 };
    const names = await collectAllPages(ordered);
    expect(names).toEqual(
      Array.from({ length: 120 }, (_, index) => `history-${String(index + 1).padStart(4, '0')}`),
    );
    const first = await searchPage(ordered);
    // A different page size starts the next page at the same place.
    const resized = await searchPage({ ...ordered, limit: 10, cursor: first.nextCursor! });
    expect(resized.items[0]!.name).toBe('history-0051');

    const keysetFirst = await searchPage({ limit: 10 });
    for (const changed of [
      { ...ordered, orderBy: ['metrics.loss DESC'], cursor: first.nextCursor! },
      { ...ordered, filter: 'metrics.loss > 3', cursor: first.nextCursor! },
      { ...ordered, statuses: ['failed' as const], cursor: first.nextCursor! },
      // A keyset cursor cannot continue an ordered search and vice versa.
      { ...ordered, cursor: keysetFirst.nextCursor! },
      { limit: 10, cursor: first.nextCursor! },
      { limit: 10, cursor: 'not-a-cursor' },
    ]) {
      const response = await searchRuns(changed);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('invalid_cursor');
    }
    // Reordering set-like conditions keeps the cursor valid.
    const both = { statuses: ['queued', 'running'] as Run['status'][], limit: 10 };
    const bothFirst = await searchPage(both);
    expect(
      (
        await searchRuns({
          statuses: ['running', 'queued'],
          limit: 10,
          cursor: bothFirst.nextCursor!,
        })
      ).status,
    ).toBe(200);
  });

  it('NaNと欠損のmetricsをMLflowと同じ順に並べ、同じfilterで同じRunを返す', async () => {
    const mlflow = trackingClient(trackingTestApp(harness), fixture);
    const runIdsByName = new Map<string, string>();
    for (const [name, value] of [
      ['high', 3],
      ['nan', 'NaN'],
      ['low', 1],
      ['missing', null],
    ] as const) {
      const run = await mlflow.createRun({ run_name: name });
      runIdsByName.set(name, run.info.run_id);
      await entity(
        await mlflow.post('/runs/log-batch', {
          run_id: run.info.run_id,
          params: [{ key: 'variant', value: name === 'missing' ? 'B' : 'A' }],
          metrics:
            value === null ? [] : [{ key: 'score', value, timestamp: 1700000000000, step: 1 }],
        }),
        200,
      );
    }
    for (const orderBy of ['metrics.score ASC', 'metrics.score DESC']) {
      const mlflowRuns = await entity<{ runs: WireRun[] }>(
        await mlflow.post('/runs/search', {
          experiment_ids: [fixture.experiment.id],
          order_by: [orderBy],
        }),
        200,
      );
      const native = await searchPage({ orderBy: [orderBy] });
      expect(native.items.map((run) => run.name)).toEqual(
        mlflowRuns.runs.map((run) => run.info.run_name),
      );
      expect(native.items.slice(-2).map((run) => run.name)).toEqual(['nan', 'missing']);
    }
    for (const filter of [
      "params.variant = 'A' AND metrics.score >= 1",
      'metrics.score != 1',
      'tags.none IS NULL AND attributes.status = "RUNNING"',
    ]) {
      const mlflowRuns = await entity<{ runs?: WireRun[] }>(
        await mlflow.post('/runs/search', { experiment_ids: [fixture.experiment.id], filter }),
        200,
      );
      const native = await searchPage({ filter });
      expect(native.items.map((run) => run.id).sort()).toEqual(
        (mlflowRuns.runs ?? []).map((run) => run.info.run_id).sort(),
      );
    }
  });

  it('実行paramsとSDKが記録したparamsを合成して検索する', async () => {
    const run = await createRun({ name: 'merged', parameters: { batch_size: 32, lr: 0.1 } });
    const mlflow = trackingClient(trackingTestApp(harness), fixture);
    await entity(
      await mlflow.post('/runs/log-parameter', {
        run_id: run.id,
        key: 'optimizer',
        value: 'adamw',
      }),
      200,
    );
    await createRun({ name: 'other', parameters: { batch_size: 64 } });
    const merged = await searchPage({
      filter: "params.batch_size = '32' AND params.optimizer = 'adamw'",
    });
    expect(merged.items.map((item) => item.name)).toEqual(['merged']);
  });

  it('削除済みRunを除き、絞り込み条件を組み合わせる', async () => {
    const other = await entity<Experiment>(
      await request(harness.app, `${fixture.basePath}/experiments`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Other Experiment' },
      }),
    );
    const parent = await createRun({ name: 'parent', kind: 'training' });
    const child = await createRun({ name: 'child', kind: 'evaluation', parentRunId: parent.id });
    const removed = await createRun({ name: 'removed' });
    await createRun({ name: 'elsewhere', experimentId: other.id, kind: 'evaluation' });
    const mlflow = trackingClient(trackingTestApp(harness), fixture);
    await entity(await mlflow.post('/runs/delete', { run_id: removed.id }), 200);

    const names = async (body: RunSearchRequest) =>
      (await searchPage(body)).items.map((run) => run.name).sort();
    expect(await names({})).toEqual(['child', 'elsewhere', 'parent']);
    expect(await names({ experimentIds: [fixture.experiment.id] })).toEqual(['child', 'parent']);
    expect(await names({ kinds: ['evaluation'] })).toEqual(['child', 'elsewhere']);
    expect(await names({ parentRunId: parent.id })).toEqual(['child']);
    expect(await names({ statuses: ['finished'] })).toEqual([]);
    expect(await names({ filter: "attributes.run_id IN ('" + child.id + "')" })).toEqual(['child']);
  });

  it('構文エラー・上限超過は400/422、他Projectのexperimentは404を返す', async () => {
    const syntax = await searchRuns({ filter: "tags.a = 'b' OR tags.a = 'c'" });
    expect(syntax.status).toBe(400);
    expect(((await syntax.json()) as { code: string }).code).toBe('invalid_parameter_value');
    expect((await searchRuns({ orderBy: ['metrics.loss SIDEWAYS'] })).status).toBe(400);
    expect((await searchRuns({ filter: 'x'.repeat(2001) })).status).toBe(422);
    expect((await searchRuns({ limit: 501 })).status).toBe(422);
    expect((await searchRuns({ orderBy: Array(6).fill('metrics.loss') })).status).toBe(422);

    const foreign = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { name: 'Foreign Project' },
      }),
    );
    const foreignExperiment = await entity<Experiment>(
      await request(harness.app, `/api/projects/${foreign.id}/experiments`, {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { name: 'Foreign Experiment' },
      }),
    );
    expect((await searchRuns({ experimentIds: [foreignExperiment.id] })).status).toBe(404);
  });

  it('非メンバー・他Project限定token・read scopeの無いtokenは検索できない', async () => {
    await createRun({ name: 'visible' });
    expect((await searchRuns({}, { cookie: fixture.outsider.cookie })).status).toBe(403);
    const mintToken = async (body: { projectId: string; scopes: string[] }) =>
      (
        await entity<{ token: string }>(
          await request(harness.app, '/api/tokens', {
            method: 'POST',
            cookie: fixture.administrator.cookie,
            body: { name: 'Run search test', kind: 'personal', ...body },
          }),
        )
      ).token;
    const readable = await mintToken({ projectId: fixture.project.id, scopes: ['read'] });
    const page = await entity<RunSearchPage>(await searchRuns({}, { token: readable }), 200);
    expect(page.items.map((run) => run.name)).toEqual(['visible']);

    const writeOnly = await mintToken({ projectId: fixture.project.id, scopes: ['runs:write'] });
    expect((await searchRuns({}, { token: writeOnly })).status).toBe(403);

    const otherProject = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Second Project' },
      }),
    );
    const restricted = await mintToken({ projectId: otherProject.id, scopes: ['read'] });
    expect((await searchRuns({}, { token: restricted })).status).toBe(403);
  });
});
