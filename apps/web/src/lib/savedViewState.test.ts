import { describe, expect, it } from 'vitest';
import type { ChartPanelLayout, SavedViewState } from '@mmt/contracts';
import {
  hasUnsavedChanges,
  parseSavedViewState,
  runSortFromOrderBy,
  toRunListDisplay,
  toSavedViewState,
  type RunListDisplay,
} from './savedViewState';
import { metricRunSort } from './runFilter';

const layout: ChartPanelLayout = {
  version: 1,
  columns: 12,
  panels: [
    {
      id: 'loss',
      metricKeys: ['loss'],
      xAxis: { kind: 'step' },
      yScale: 'log',
      smoothing: { kind: 'ema', weight: 0.6 },
      showRange: true,
      layout: { x: 0, y: 0, w: 6, h: 2 },
    },
    {
      id: 'wer',
      metricKeys: ['eval/wer'],
      xAxis: { kind: 'step' },
      yScale: 'linear',
      smoothing: { kind: 'none', weight: 0 },
      showRange: false,
      layout: { x: 6, y: 0, w: 6, h: 2 },
    },
  ],
};

const display: RunListDisplay = {
  experimentId: 'exp-1',
  searchText: "metrics.loss < 0.5 AND params.optimizer = 'adam'",
  status: 'finished',
  kinds: ['training'],
  sort: metricRunSort('eval/wer', 'asc'),
  columns: [{ key: 'metrics.eval/wer', width: 140 }, { key: 'status' }, { key: 'description' }],
  chartPanels: layout,
};

describe('保存ビューの状態の変換', () => {
  it('画面の状態を保存して開き直すと、同じ表示に戻る', () => {
    const state = toSavedViewState(display);
    expect(state).toMatchObject({
      version: 1,
      experimentIds: ['exp-1'],
      filter: "metrics.loss < 0.5 AND params.optimizer = 'adam'",
      orderBy: ['metrics.`eval/wer` ASC'],
      statuses: ['finished'],
      kinds: ['training'],
    });
    expect(toRunListDisplay(state)).toEqual(display);
  });

  it('Run名の検索は検索式として保存し、開くと元の検索語に戻る', () => {
    const state = toSavedViewState({ ...display, searchText: "bob's run" });
    expect(state.filter).toBe("attributes.run_name ILIKE '%bob''s run%'");
    expect(toRunListDisplay(state).searchText).toBe("bob's run");
  });

  it('既定の図の配置は空の配置として保存し、開くと既定の配置に戻る', () => {
    const state = toSavedViewState({ ...display, chartPanels: null });
    expect(state.chartPanels.panels).toEqual([]);
    expect(toRunListDisplay(state).chartPanels).toBeNull();
  });

  it('図のグループ化はgroupByとしても保存し、groupByだけのビューは全パネルに適用して開く', () => {
    const grouped = {
      ...layout,
      panels: layout.panels.map((panel) => ({ ...panel, groupBy: { kind: 'param' as const, key: 'lr' } })),
    };
    expect(toSavedViewState({ ...display, chartPanels: grouped }).groupBy).toEqual({
      kind: 'param',
      key: 'lr',
    });
    const opened = toRunListDisplay({
      ...toSavedViewState(display),
      groupBy: { kind: 'experiment' },
    });
    expect(opened.chartPanels?.panels.map((panel) => panel.groupBy)).toEqual([
      { kind: 'experiment' },
      { kind: 'experiment' },
    ]);
  });

  it('並び順は一覧の選択肢へ戻し、選べない並び順は新しい順として開く', () => {
    expect(runSortFromOrderBy([])).toBe('newest');
    expect(runSortFromOrderBy(['attributes.start_time ASC'])).toBe('oldest');
    expect(runSortFromOrderBy(['attributes.run_name ASC'])).toBe('name');
    expect(runSortFromOrderBy(['metrics.loss DESC'])).toBe(metricRunSort('loss', 'desc'));
    expect(runSortFromOrderBy(['metrics.`a``b` asc'])).toBe(metricRunSort('a`b', 'asc'));
    expect(runSortFromOrderBy(['params.lr ASC'])).toBeNull();
    expect(runSortFromOrderBy(['metrics.loss DESC', 'attributes.run_name ASC'])).toBeNull();
  });
});

describe('保存ビューの状態の検証', () => {
  it('versionが1以外の状態は開かずに理由を返す', () => {
    const state = { ...toSavedViewState(display), version: 2 };
    expect(parseSavedViewState(state)).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(parseSavedViewState(null)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('壊れた図の配置や列は形の違反として拒否する', () => {
    const state = toSavedViewState(display);
    expect(parseSavedViewState({ ...state, chartPanels: { version: 1, columns: 8, panels: [] } })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(parseSavedViewState({ ...state, columns: [{ width: 10 }] })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(parseSavedViewState(state)).toEqual({ ok: true, state });
  });
});

describe('未保存の変更の判定', () => {
  const saved: SavedViewState = toSavedViewState(display);

  it('保存した直後は変更なし、条件・列・図を変えると変更あり', () => {
    expect(hasUnsavedChanges(saved, toSavedViewState(display))).toBe(false);
    expect(hasUnsavedChanges(saved, toSavedViewState({ ...display, status: 'failed' }))).toBe(true);
    expect(hasUnsavedChanges(saved, toSavedViewState({ ...display, kinds: [] }))).toBe(true);
    expect(
      hasUnsavedChanges(
        saved,
        toSavedViewState({ ...display, columns: [{ key: 'status' }, { key: 'metrics.eval/wer', width: 140 }, { key: 'description' }] }),
      ),
    ).toBe(true);
    expect(
      hasUnsavedChanges(
        saved,
        toSavedViewState({ ...display, columns: [{ key: 'metrics.eval/wer', width: 200 }, { key: 'status' }, { key: 'description' }] }),
      ),
    ).toBe(true);
    const narrower = { ...layout, panels: [{ ...layout.panels[0]!, layout: { x: 0, y: 0, w: 4, h: 2 } }, layout.panels[1]!] };
    expect(hasUnsavedChanges(saved, toSavedViewState({ ...display, chartPanels: narrower }))).toBe(true);
  });

  it('パネルの並びや前後の空白だけが違う状態は変更とみなさない', () => {
    const reordered = { ...saved, filter: `${saved.filter} `, chartPanels: { ...layout, panels: [...layout.panels].reverse() } };
    expect(hasUnsavedChanges(saved, reordered)).toBe(false);
  });

  it('一覧に出せない条件（2件目以降のExperiment）は開いた表示と比べる', () => {
    const fromApi: SavedViewState = { ...saved, experimentIds: ['exp-1', 'exp-2'] };
    expect(hasUnsavedChanges(fromApi, toSavedViewState(toRunListDisplay(fromApi)))).toBe(false);
  });

  it('実行種別は開いて上書き保存しても消えず、APIで保存した複数の種別も残る', () => {
    const fromApi: SavedViewState = { ...saved, kinds: ['inference', 'evaluation'] };
    const resaved = toSavedViewState(toRunListDisplay(fromApi));
    expect(resaved.kinds).toEqual(['inference', 'evaluation']);
    expect(hasUnsavedChanges(fromApi, resaved)).toBe(false);
  });
});
