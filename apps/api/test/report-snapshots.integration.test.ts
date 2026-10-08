import type {
  MetricSeriesResponse,
  ReportBlock,
  ReportBlockSnapshot,
  ReportDetail,
  ReportSnapshotList,
  Run,
  SavedView,
} from '@mmt/contracts';
import { reportSnapshotListSchema } from '@mmt/contracts/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

type Fixture = Awaited<ReturnType<typeof projectFixture>>;

const lossPanel = {
  id: 'loss',
  metricKeys: ['loss'],
  xAxis: { kind: 'step' },
  yScale: 'linear',
  smoothing: { kind: 'none', weight: 0 },
  showRange: false,
  layout: { x: 0, y: 0, w: 12, h: 4 },
};

describe.skipIf(!testDatabaseUrl)('レポートの作成時点での固定（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  let reportsPath: string;
  let runs: Run[];

  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
    reportsPath = `${fixture.basePath}/reports`;
    runs = [];
    for (const name of ['baseline', 'tuned'])
      runs.push(
        await entity<Run>(
          await request(harness.app, `${fixture.basePath}/runs`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { experimentId: fixture.experiment.id, name, kind: 'training', parameters: { lr: name.length } },
          }),
        ),
      );
    for (const run of runs) await logLoss(run.id, [0, 1, 2]);
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function logLoss(runId: string, steps: number[]): Promise<void> {
    await harness.database.query(
      `INSERT INTO metrics(run_id,name,value,step,timestamp)
      SELECT $1,'loss',1.0/(step+1),step,now() FROM unnest($2::bigint[]) AS step`,
      [runId, steps],
    );
    await harness.database.query(
      `UPDATE runs SET latest_metrics=latest_metrics || jsonb_build_object('loss',$2::float8) WHERE id=$1`,
      [runId, 1 / (Math.max(...steps) + 1)],
    );
  }

  function chart(mode: 'live' | 'snapshot', id = `chart-${mode}`): ReportBlock {
    return {
      type: 'chart',
      id,
      panel: lossPanel,
      runSet: { runIds: runs.map((run) => run.id) },
      mode,
    } as ReportBlock;
  }

  async function createReport(blocks: ReportBlock[], app = harness.app) {
    return request(app, reportsPath, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { title: 'Fixed results', blocks },
    });
  }

  async function readSnapshots(reportId: string, revision?: number): Promise<ReportSnapshotList> {
    const list = await entity<ReportSnapshotList>(
      await request(
        harness.app,
        `${reportsPath}/${reportId}/snapshots${revision === undefined ? '' : `?revision=${revision}`}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    // Every kind of snapshot data has exactly the published shape (docs/openapi.json).
    return reportSnapshotListSchema.parse(list);
  }

  function snapshotOf(list: ReportSnapshotList, blockId: string): ReportBlockSnapshot {
    const snapshot = list.items.find((item) => item.blockId === blockId);
    expect(snapshot, blockId).toBeDefined();
    return snapshot!;
  }

  function pointCount(snapshot: ReportBlockSnapshot): number {
    if (snapshot.data.type !== 'chart') throw new Error('not a chart snapshot');
    return snapshot.data.series!.reduce((total, series) => total + series.points.length, 0);
  }

  async function liveSeriesPointCount(): Promise<number> {
    const response = await entity<MetricSeriesResponse>(
      await request(harness.app, `${fixture.basePath}/metrics/series`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { runIds: runs.map((run) => run.id), keys: ['loss'], xAxis: { kind: 'step' } },
      }),
      200,
    );
    return response.series.reduce((total, series) => total + series.points.length, 0);
  }

  it('snapshotのブロックは保存後にmetricsを足しても変わらず、liveのデータは変わる', async () => {
    const created = await entity<ReportDetail>(await createReport([chart('snapshot'), chart('live')]));
    const before = await readSnapshots(created.report.id);
    // Only snapshot blocks are captured.
    expect(before.items.map((item) => item.blockId)).toEqual(['chart-snapshot']);
    const fixed = snapshotOf(before, 'chart-snapshot');
    expect(fixed).toMatchObject({ capturedRevision: 1 });
    expect(fixed.data).toMatchObject({
      type: 'chart',
      runs: runs.map((run) => ({ runId: run.id, name: run.name })),
    });
    expect(pointCount(fixed)).toBe(6);
    expect(await liveSeriesPointCount()).toBe(6);

    for (const run of runs) await logLoss(run.id, [3, 4]);

    const after = await readSnapshots(created.report.id);
    expect(snapshotOf(after, 'chart-snapshot')).toEqual(fixed);
    expect(await liveSeriesPointCount()).toBe(10);
  });

  it('同じ内容の再保存は作成時点を保ち、refresh指定のブロックだけ取り込み直す', async () => {
    const created = await entity<ReportDetail>(
      await createReport([chart('snapshot', 'kept'), chart('snapshot', 'refreshed')]),
    );
    const first = await readSnapshots(created.report.id);
    for (const run of runs) await logLoss(run.id, [3, 4]);

    const resaved = await entity<ReportDetail>(
      await request(harness.app, `${reportsPath}/${created.report.id}`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        body: {
          baseRevision: 1,
          title: 'Fixed results',
          blocks: created.revision.blocks,
          refreshSnapshotBlockIds: ['refreshed'],
        },
      }),
      200,
    );
    const second = await readSnapshots(created.report.id, resaved.revision.revision);
    expect(second.revision).toBe(2);
    expect(snapshotOf(second, 'kept')).toEqual(snapshotOf(first, 'kept'));
    const refreshed = snapshotOf(second, 'refreshed');
    expect(refreshed.capturedRevision).toBe(2);
    expect(Date.parse(refreshed.capturedAt)).toBeGreaterThan(
      Date.parse(snapshotOf(first, 'refreshed').capturedAt),
    );
    expect(pointCount(refreshed)).toBe(10);
    // The earlier revision keeps its own data.
    expect(snapshotOf(await readSnapshots(created.report.id, 1), 'refreshed')).toEqual(
      snapshotOf(first, 'refreshed'),
    );

    // Changing a block's content captures it again even without refresh.
    const changed = created.revision.blocks.map((block) =>
      block.id === 'kept' && block.type === 'chart'
        ? { ...block, panel: { ...block.panel, title: 'Loss' } }
        : block,
    );
    await entity(
      await request(harness.app, `${reportsPath}/${created.report.id}`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        body: { baseRevision: 2, title: 'Fixed results', blocks: changed },
      }),
      200,
    );
    const third = await readSnapshots(created.report.id, 3);
    expect(snapshotOf(third, 'kept').capturedRevision).toBe(3);
    expect(snapshotOf(third, 'refreshed').capturedRevision).toBe(2);
  });

  it('restoreは元の版の固定データを引き継ぐ', async () => {
    const created = await entity<ReportDetail>(await createReport([chart('snapshot')]));
    for (const run of runs) await logLoss(run.id, [3, 4]);
    await entity(
      await request(harness.app, `${reportsPath}/${created.report.id}`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        body: {
          baseRevision: 1,
          title: 'Fixed results',
          blocks: created.revision.blocks,
          refreshSnapshotBlockIds: ['chart-snapshot'],
        },
      }),
      200,
    );
    await entity(
      await request(harness.app, `${reportsPath}/${created.report.id}/restore`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { revision: 1 },
      }),
    );
    const restored = snapshotOf(await readSnapshots(created.report.id, 3), 'chart-snapshot');
    expect(restored).toEqual(snapshotOf(await readSnapshots(created.report.id, 1), 'chart-snapshot'));
    expect(pointCount(restored)).toBe(6);
  });

  it('分析表・Run一覧・保存ビューのRun集合を固定できる', async () => {
    const view = await entity<SavedView>(
      await request(harness.app, `${fixture.basePath}/saved-views`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          visibility: 'project',
          name: 'tuned only',
          state: {
            version: 1,
            experimentIds: [fixture.experiment.id],
            filter: "attributes.run_name = 'tuned'",
            orderBy: [],
            statuses: [],
            kinds: [],
            columns: [],
            chartPanels: { version: 1, columns: 12, panels: [] },
          },
        },
      }),
    );
    const created = await entity<ReportDetail>(
      await createReport([
        {
          type: 'parallel_coordinates',
          id: 'pc',
          runSet: { runIds: runs.map((run) => run.id) },
          params: ['lr'],
          metric: 'loss',
          mode: 'snapshot',
        },
        {
          type: 'run_table',
          id: 'view-table',
          runSet: { savedViewId: view.id },
          columns: ['metrics.loss'],
          limit: 10,
          mode: 'snapshot',
        },
        {
          type: 'scatter',
          id: 'scatter',
          runSet: { runIds: runs.map((run) => run.id) },
          x: 'params.lr',
          y: 'metrics.loss',
          mode: 'snapshot',
        },
      ]),
    );
    const list = await readSnapshots(created.report.id);
    const table = snapshotOf(list, 'pc').data;
    expect(table.type === 'parallel_coordinates' && table.table.runs.length).toBe(2);
    const scatter = snapshotOf(list, 'scatter').data;
    expect(scatter.type === 'scatter' && scatter.table.params.map((param) => param.key)).toEqual([
      'lr',
    ]);
    const viewTable = snapshotOf(list, 'view-table').data;
    expect(viewTable.type === 'run_table' && viewTable.runs.map((run) => run.name)).toEqual([
      'tuned',
    ]);
  });

  it('mediaの固定データは格子と並べたRunの名前を持つ', async () => {
    for (const run of runs) {
      const audio = await entity<{ id: string }>(
        await request(harness.app, `${fixture.basePath}/runs/${run.id}/artifacts?path=eval%2Fstep-0.wav`, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: `audio of ${run.name}`,
          headers: { 'Content-Type': 'audio/wav' },
        }),
      );
      await entity(
        await request(harness.app, `${fixture.basePath}/runs/${run.id}/media`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { items: [{ key: 'eval/audio', step: 0, kind: 'audio', artifactId: audio.id }] },
        }),
        201,
      );
    }
    const created = await entity<ReportDetail>(
      await createReport([
        {
          type: 'media',
          id: 'listen',
          runIds: runs.map((run) => run.id),
          key: 'eval/audio',
          mode: 'snapshot',
        },
      ]),
    );
    const media = snapshotOf(await readSnapshots(created.report.id), 'listen').data;
    expect(media.type === 'media' && media.runs).toEqual(
      runs.map((run) => ({ runId: run.id, name: run.name })),
    );
    expect(media.type === 'media' && media.grid.rows.map((row) => row.runId)).toEqual(
      runs.map((run) => run.id),
    );
  });

  it('5MiBを超えるブロックの固定は413で、版を作らない', async () => {
    // 500 Runs with 12KB of parameters each make a Run table snapshot of about 6MB.
    await harness.database.query(
      `INSERT INTO runs(project_id,experiment_id,name,kind,status,parameters,created_by)
      SELECT $1,$2,'bulk-'||n,'training','finished',jsonb_build_object('notes',repeat('x',12000)),$3
      FROM generate_series(1,500) AS n`,
      [fixture.project.id, fixture.experiment.id, fixture.editor.userId],
    );
    const table: ReportBlock = {
      type: 'run_table',
      id: 'huge',
      runSet: { search: { experimentIds: [fixture.experiment.id] } },
      columns: ['params.notes'],
      limit: 500,
      mode: 'snapshot',
    };
    const response = await createReport([table]);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('report_snapshot_too_large');
    // The same block drawn live stores nothing and is accepted.
    expect((await createReport([{ ...table, mode: 'live' }])).status).toBe(201);
    const stored = await harness.database.query(
      'SELECT count(*)::int AS count FROM report_block_snapshots',
    );
    expect(stored.rows[0]).toEqual({ count: 0 });
  });

  it('1つの版の固定データの合計がMMT_REPORT_SNAPSHOT_MAX_BYTESを超えると413', async () => {
    const created = await entity<ReportDetail>(await createReport([chart('snapshot', 'one')]));
    const [snapshot] = (await readSnapshots(created.report.id)).items;
    // A limit that holds one chart but not two.
    const limited = createApplication({
      config: { ...harness.config, reportSnapshotMaxBytes: Math.floor(snapshot!.sizeBytes * 1.5) },
      database: harness.database,
      stores: harness.stores,
    });
    expect((await createReport([chart('snapshot', 'one')], limited.app)).status).toBe(201);
    const response = await createReport(
      [chart('snapshot', 'one'), chart('snapshot', 'two')],
      limited.app,
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('report_snapshot_too_large');
    await limited.outbox.stop();
  });
});
