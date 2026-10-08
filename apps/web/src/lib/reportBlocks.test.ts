import { describe, expect, it } from 'vitest';
import type { ReportBlock, SavedViewState } from '@mmt/contracts';
import {
  analysisTableRequest,
  createBlock,
  formatSnapshotTime,
  insertBlock,
  moveBlock,
  refreshableSnapshotIds,
  removeBlock,
  replaceBlock,
  reportBlockProblem,
  reportChartSeries,
  RUN_SEARCH_FILTER_MAX_LENGTH,
  runIdFilters,
  savedViewSearch,
  toAnalysisRunSet,
} from './reportBlocks';

const markdown = (id: string, text = ''): ReportBlock => ({ id, type: 'markdown', text });
const ids = (blocks: ReportBlock[]) => blocks.map((block) => block.id);

describe('ブロックの追加・移動・削除', () => {
  const blocks = [markdown('a'), markdown('b'), markdown('c')];

  it('位置を指定しなければ末尾に、指定すればその位置に入る', () => {
    expect(ids(insertBlock(blocks, markdown('d')))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(insertBlock(blocks, markdown('d'), 1))).toEqual(['a', 'd', 'b', 'c']);
    expect(ids(insertBlock(blocks, markdown('d'), 99))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('上下へ1つずつ動き、端を越える移動では並びが変わらない', () => {
    expect(ids(moveBlock(blocks, 'b', -1))).toEqual(['b', 'a', 'c']);
    expect(ids(moveBlock(blocks, 'b', 1))).toEqual(['a', 'c', 'b']);
    expect(ids(moveBlock(blocks, 'a', -1))).toEqual(['a', 'b', 'c']);
    expect(ids(moveBlock(blocks, 'c', 1))).toEqual(['a', 'b', 'c']);
    expect(ids(moveBlock(blocks, 'missing', 1))).toEqual(['a', 'b', 'c']);
  });

  it('削除と置き換えはidで対象を選び、元の配列は変えない', () => {
    expect(ids(removeBlock(blocks, 'b'))).toEqual(['a', 'c']);
    const replaced = replaceBlock(blocks, markdown('b', '本文'));
    expect(replaced[1]).toEqual(markdown('b', '本文'));
    expect(blocks[1]).toEqual(markdown('b'));
  });
});

describe('新しいブロックの既定値', () => {
  it('埋め込みは最新データで始まり、図は1列いっぱいのパネルになる', () => {
    const chart = createBlock('chart', 'chart-1', { sweepId: 'sweep' });
    expect(chart).toMatchObject({
      type: 'chart',
      mode: 'live',
      runSet: { sweepId: 'sweep' },
      panel: { id: 'chart-1', metricKeys: [], layout: { x: 0, w: 12 } },
    });
  });

  it('設定が足りないブロックは保存できない理由を返す', () => {
    expect(reportBlockProblem(createBlock('chart', 'c'))).toBe('runSetEmpty');
    expect(reportBlockProblem(createBlock('chart', 'c', { runIds: ['r1'] }))).toBe('chartMetricsEmpty');
    expect(reportBlockProblem(createBlock('media', 'm'))).toBe('mediaRunsEmpty');
    expect(reportBlockProblem(createBlock('media_table', 't'))).toBe('mediaTableEmpty');
    expect(reportBlockProblem(markdown('text'))).toBeNull();
  });

  it('重要度はSweepなら目的関数を使えるので指標なしでよいが、ほかのRun集合では指標が要る', () => {
    expect(reportBlockProblem({ id: 'i', type: 'parameter_importance', runSet: { sweepId: 's' }, mode: 'live' })).toBeNull();
    expect(reportBlockProblem({ id: 'i', type: 'parameter_importance', runSet: { runIds: ['r'] }, mode: 'live' })).toBe(
      'importanceTargetEmpty',
    );
  });

  it('散布図は分析表のためにどれかの軸にメトリクスが要る', () => {
    const scatter = { id: 's', type: 'scatter' as const, runSet: { runIds: ['r'] }, mode: 'live' as const };
    expect(reportBlockProblem({ ...scatter, x: 'params.lr', y: 'params.batch' })).toBe('scatterMetricMissing');
    expect(reportBlockProblem({ ...scatter, x: 'params.lr', y: 'params.batch', color: 'metrics.loss' })).toBeNull();
  });
});

describe('Run集合からliveの取得条件への変換', () => {
  const state: SavedViewState = {
    version: 1,
    experimentIds: ['exp'],
    filter: "metrics.loss < 0.5",
    orderBy: ['metrics.loss ASC'],
    statuses: ['finished'],
    kinds: [],
    columns: [{ key: 'metrics.loss' }],
    chartPanels: { version: 1, columns: 12, panels: [] },
  };

  it('保存ビューは表示列や図を除いた検索条件になり、空の条件は送らない', () => {
    expect(savedViewSearch(state)).toEqual({
      experimentIds: ['exp'],
      filter: 'metrics.loss < 0.5',
      orderBy: ['metrics.loss ASC'],
      statuses: ['finished'],
    });
    expect(toAnalysisRunSet({ savedViewId: 'view' }, state)).toEqual({ search: savedViewSearch(state) });
  });

  it('保存ビュー以外のRun集合はそのまま分析APIへ渡す', () => {
    expect(toAnalysisRunSet({ runIds: ['a'] })).toEqual({ runIds: ['a'] });
    expect(toAnalysisRunSet({ sweepId: 's' })).toEqual({ sweepId: 's' });
    expect(() => toAnalysisRunSet({ savedViewId: 'view' })).toThrow();
  });

  it('選んだRunは検索の上限に収まるrun_idのIN条件に分け、引用符はエスケープする', () => {
    const runIds = Array.from({ length: 200 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const filters = runIdFilters(runIds);
    expect(filters.length).toBeGreaterThan(1);
    for (const filter of filters) expect(filter.length).toBeLessThanOrEqual(RUN_SEARCH_FILTER_MAX_LENGTH);
    const listed = filters.flatMap((filter) => [...filter.matchAll(/'([^']+)'/g)].map((match) => match[1]));
    expect(listed).toEqual(runIds);
    expect(runIdFilters(["it's"])).toEqual(["attributes.run_id IN ('it''s')"]);
    expect(runIdFilters([])).toEqual([]);
  });

  it('散布図と平行座標は使う軸だけをparamsとmetricsに分けて分析表に頼む', () => {
    expect(
      analysisTableRequest(
        { id: 's', type: 'scatter', runSet: { runIds: ['r'] }, x: 'params.lr', y: 'metrics.loss', color: 'metrics.loss', mode: 'live' },
        { runIds: ['r'] },
      ),
    ).toEqual({ runSet: { runIds: ['r'] }, params: ['lr'], metrics: ['loss'] });
    expect(
      analysisTableRequest(
        { id: 'p', type: 'parallel_coordinates', runSet: { sweepId: 's' }, params: ['lr', 'depth'], metric: 'acc', mode: 'live' },
        { sweepId: 's' },
      ),
    ).toEqual({ runSet: { sweepId: 's' }, params: ['lr', 'depth'], metrics: ['acc'] });
  });
});

describe('固定データ', () => {
  it('作り直す指定は、今も固定のブロックだけを送る', () => {
    const blocks: ReportBlock[] = [
      { ...createBlock('run_table', 'fixed', { runIds: ['r'] }), mode: 'snapshot' } as ReportBlock,
      createBlock('run_table', 'live', { runIds: ['r'] }),
      markdown('text'),
    ];
    expect(refreshableSnapshotIds(blocks, new Set(['fixed', 'live', 'text', 'gone']))).toEqual(['fixed']);
  });

  it('固定した時刻は閲覧者の時刻で YYYY-MM-DD HH:mm にする', () => {
    const time = new Date(2026, 9, 8, 7, 5);
    expect(formatSnapshotTime(time.toISOString())).toBe('2026-10-08 07:05');
  });

  it('グループの図は平均線と範囲を、複数のメトリクスはRunとキーの組を1本にする', () => {
    const groups = reportChartSeries(
      {
        type: 'chart',
        runs: [],
        groups: [
          {
            groupKey: 'a',
            label: 'lr=0.1',
            runIds: ['r1', 'r2'],
            series: [{ key: 'loss', points: [{ x: 1, mean: 2, min: 1, max: 3, stddev: 1, runCount: 2 }] }],
          },
        ],
      },
      ['loss'],
    );
    expect(groups).toEqual([
      { id: 'group:a', label: 'lr=0.1', kind: 'group', points: [{ x: 1, value: 2, min: 1, max: 3 }] },
    ]);
    const point = { x: 1, step: 1, value: 0.5, min: 0.5, max: 0.5, count: 1 };
    const series = reportChartSeries(
      {
        type: 'chart',
        runs: [{ runId: 'r1', name: 'run-1' }],
        series: ['loss', 'acc'].map((key) => ({ runId: 'r1', key, points: [point], sampled: false, totalPoints: 1, nanCount: 0, droppedPoints: 0 })),
      },
      ['loss', 'acc'],
    );
    expect(series.map((line) => [line.id, line.label])).toEqual([
      ['r1/loss', 'run-1 · loss'],
      ['r1/acc', 'run-1 · acc'],
    ]);
  });
});
