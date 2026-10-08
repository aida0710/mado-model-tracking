import { SAVED_VIEW_MAX_COLUMNS, SAVED_VIEW_STATE_MAX_BYTES } from '@mmt/contracts';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { savedViewCreateSchema, validateSavedViewState } from './savedViewValidation.js';

function panel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'loss',
    metricKeys: ['loss'],
    xAxis: { kind: 'step' },
    yScale: 'linear',
    smoothing: { kind: 'ema', weight: 0.6 },
    showRange: false,
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    experimentIds: [],
    filter: "metrics.loss < 0.5 AND params.lr = '0.01'",
    orderBy: ['metrics.loss ASC'],
    statuses: ['finished'],
    kinds: ['training'],
    columns: [{ key: 'metrics.loss', width: 120 }, { key: 'params.lr' }],
    chartPanels: { version: 1, columns: 12, panels: [panel()] },
    ...overrides,
  };
}

function rejectionCode(input: unknown): string | undefined {
  try {
    validateSavedViewState(input);
    return undefined;
  } catch (error) {
    if (error instanceof DomainError && error.status === 422) return error.code;
    throw error;
  }
}

describe('保存ビューの状態の検証', () => {
  it('Run一覧の条件と図パネルの配置をそのまま受け付ける', () => {
    expect(validateSavedViewState(state({ groupBy: { kind: 'param', key: 'lr' } }))).toEqual(
      state({ groupBy: { kind: 'param', key: 'lr' } }),
    );
  });

  it('省略した検索条件は空の条件として補う', () => {
    const {
      experimentIds: _e,
      filter: _f,
      orderBy: _o,
      statuses: _s,
      kinds: _k,
      ...rest
    } = state();
    expect(validateSavedViewState(rest)).toMatchObject({
      experimentIds: [],
      filter: '',
      orderBy: [],
      statuses: [],
      kinds: [],
    });
  });

  it('列は200件まで受け付け、201件と重複したkeyは拒否する', () => {
    const columns = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ key: `metrics.m${index}` }));
    expect(rejectionCode(state({ columns: columns(SAVED_VIEW_MAX_COLUMNS) }))).toBeUndefined();
    expect(rejectionCode(state({ columns: columns(SAVED_VIEW_MAX_COLUMNS + 1) }))).toBe(
      'invalid_request',
    );
    expect(
      rejectionCode(state({ columns: [{ key: 'metrics.loss' }, { key: 'metrics.loss' }] })),
    ).toBe('invalid_request');
  });

  it('図パネルは12列のgridに収まる形だけを受け付ける', () => {
    const layout = (panels: unknown[], extra: Record<string, unknown> = {}) =>
      state({ chartPanels: { version: 1, columns: 12, panels, ...extra } });
    expect(rejectionCode(layout([panel({ layout: { x: 6, y: 0, w: 6, h: 4 } })]))).toBeUndefined();
    expect(rejectionCode(layout([panel({ layout: { x: 8, y: 0, w: 6, h: 4 } })]))).toBe(
      'invalid_request',
    );
    expect(rejectionCode(layout([panel()], { columns: 24 }))).toBe('invalid_request');
    expect(rejectionCode(layout([panel(), panel()]))).toBe('invalid_request');
    expect(rejectionCode(layout([panel({ metricKeys: [] })]))).toBe('invalid_request');
    expect(rejectionCode(layout([panel({ smoothing: { kind: 'ema', weight: 1.5 } })]))).toBe(
      'invalid_request',
    );
    // The metric axis needs the key it plots against, as in the metric series API.
    expect(rejectionCode(layout([panel({ xAxis: { kind: 'metric' } })]))).toBe('invalid_request');
    expect(
      rejectionCode(layout([panel({ xAxis: { kind: 'metric', metricKey: 'epoch' } })])),
    ).toBeUndefined();
    expect(rejectionCode(layout([panel({ unknownField: true })]))).toBe('invalid_request');
  });

  it('64KiBを超える状態は拒否する', () => {
    const padding = 'x'.repeat(SAVED_VIEW_STATE_MAX_BYTES);
    expect(rejectionCode(state({ columns: [{ key: 'metrics.loss' }], note: padding }))).toBe(
      'saved_view_state_too_large',
    );
  });

  it('未知のversionは形の検証より先に拒否する', () => {
    expect(rejectionCode(state({ version: 2 }))).toBe('saved_view_state_unsupported_version');
    expect(rejectionCode({})).toBe('saved_view_state_unsupported_version');
    expect(rejectionCode(null)).toBe('saved_view_state_unsupported_version');
  });

  it('検索できないfilterとorderByは保存時に拒否する', () => {
    expect(rejectionCode(state({ filter: 'metrics.loss <' }))).toBe('saved_view_filter_invalid');
    expect(rejectionCode(state({ filter: 'unknown_field = 1' }))).toBe('saved_view_filter_invalid');
    expect(rejectionCode(state({ orderBy: ['metrics.loss SIDEWAYS'] }))).toBe(
      'saved_view_filter_invalid',
    );
  });

  it('名前は前後の空白を除いて1〜200文字', () => {
    const create = (name: string) =>
      savedViewCreateSchema.safeParse({ visibility: 'private', name, state: state() });
    expect(create('  学習の比較  ').data?.name).toBe('学習の比較');
    expect(create('   ').success).toBe(false);
    expect(create('a'.repeat(201)).success).toBe(false);
  });
});
