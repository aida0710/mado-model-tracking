import { REPORT_MAX_BLOCKS, type ReportBlock } from '@mmt/contracts';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  collectReportReferences,
  reportBlockDigest,
  reportCreateSchema,
  reportUpdateSchema,
  scatterTableKeys,
  validateReportBlocks,
} from './reportBlocks.js';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const SWEEP = '33333333-3333-4333-8333-333333333333';
const VIEW = '44444444-4444-4444-8444-444444444444';
const EXPERIMENT = '55555555-5555-4555-8555-555555555555';
const MEDIA = '66666666-6666-4666-8666-666666666666';

const panel = {
  id: 'loss',
  metricKeys: ['loss'],
  xAxis: { kind: 'step' },
  yScale: 'linear',
  smoothing: { kind: 'none', weight: 0 },
  showRange: false,
  layout: { x: 0, y: 0, w: 12, h: 4 },
};

function parseBlocks(blocks: unknown[]) {
  return reportCreateSchema.safeParse({ title: 'Report', blocks });
}

function acceptedBlock(block: Record<string, unknown>): ReportBlock {
  const parsed = parseBlocks([block]);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.data!.blocks[0]!;
}

function expectRejected(block: Record<string, unknown>): void {
  expect(parseBlocks([block]).success).toBe(false);
}

function domainErrorCode(operation: () => void): string | undefined {
  try {
    operation();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

describe('レポートのブロックの検証', () => {
  it('各種類のブロックを受け付ける', () => {
    acceptedBlock({ type: 'markdown', id: 'intro', text: '# 結果' });
    acceptedBlock({ type: 'chart', id: 'c', panel, runSet: { runIds: [RUN_A] }, mode: 'live' });
    acceptedBlock({
      type: 'parallel_coordinates',
      id: 'p',
      runSet: { search: { filter: 'metrics.loss < 1' } },
      params: ['lr'],
      metric: 'loss',
      mode: 'snapshot',
    });
    acceptedBlock({
      type: 'parameter_importance',
      id: 'i',
      runSet: { sweepId: SWEEP },
      mode: 'snapshot',
    });
    acceptedBlock({
      type: 'scatter',
      id: 's',
      runSet: { savedViewId: VIEW },
      x: 'params.lr',
      y: 'metrics.loss',
      color: 'params.batch',
      mode: 'live',
    });
    acceptedBlock({
      type: 'run_table',
      id: 't',
      runSet: { runIds: [RUN_A, RUN_B] },
      columns: ['metrics.loss', 'params.lr'],
      limit: 500,
      mode: 'snapshot',
    });
    acceptedBlock({ type: 'media', id: 'm', runIds: [RUN_A], key: 'audio', steps: [0, 10], mode: 'snapshot' });
    acceptedBlock({ type: 'media_table', id: 'mt', runId: RUN_A, mediaId: MEDIA, mode: 'live' });
  });

  it('searchは送った条件だけを保存し、run searchの既定値で埋めない', () => {
    const block = acceptedBlock({
      type: 'run_table',
      id: 't',
      runSet: { search: { experimentIds: [EXPERIMENT], orderBy: ['metrics.loss ASC'] } },
      columns: [],
      limit: 10,
      mode: 'live',
    });
    expect(block).toMatchObject({
      runSet: { search: { experimentIds: [EXPERIMENT], orderBy: ['metrics.loss ASC'] } },
    });
    expect(Object.keys((block as { runSet: { search: object } }).runSet.search).sort()).toEqual([
      'experimentIds',
      'orderBy',
    ]);
  });

  it('上限を超える値と矛盾する指定を拒否する', () => {
    expectRejected({ type: 'markdown', id: 'x', text: 'a'.repeat(100_001) });
    expectRejected({
      type: 'run_table',
      id: 't',
      runSet: { runIds: [RUN_A] },
      columns: [],
      limit: 501,
      mode: 'live',
    });
    const tooManyRunIds = Array.from(
      { length: 201 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    );
    expectRejected({ type: 'chart', id: 'c', panel, runSet: { runIds: tooManyRunIds }, mode: 'live' });
    expectRejected({ type: 'chart', id: 'c', panel, runSet: { runIds: [RUN_A, RUN_A] }, mode: 'live' });
    const tooManyMediaRuns = tooManyRunIds.slice(0, 21);
    expectRejected({ type: 'media', id: 'm', runIds: tooManyMediaRuns, key: 'audio', mode: 'live' });
    expectRejected({
      type: 'media',
      id: 'm',
      runIds: [RUN_A],
      key: 'audio',
      steps: Array.from({ length: 51 }, (_, index) => index),
      mode: 'live',
    });
    // Exactly one source per Run set, and only the known modes.
    expectRejected({
      type: 'chart',
      id: 'c',
      panel,
      runSet: { runIds: [RUN_A], sweepId: SWEEP },
      mode: 'live',
    });
    expectRejected({ type: 'chart', id: 'c', panel, runSet: { runIds: [RUN_A] }, mode: 'frozen' });
    expectRejected({
      type: 'chart',
      id: 'c',
      panel,
      runSet: { search: { filter: 'x'.repeat(2001) } },
      mode: 'live',
    });
  });

  it('重要度の対象metricはsweep以外で必須、散布図のobjectiveはsweepだけ', () => {
    expectRejected({ type: 'parameter_importance', id: 'i', runSet: { runIds: [RUN_A] }, mode: 'live' });
    expectRejected({
      type: 'scatter',
      id: 's',
      runSet: { runIds: [RUN_A] },
      x: 'params.lr',
      y: 'objective',
      mode: 'live',
    });
    acceptedBlock({
      type: 'scatter',
      id: 's',
      runSet: { sweepId: SWEEP },
      x: 'params.lr',
      y: 'objective',
      mode: 'live',
    });
    // Two params alone give no value to plot.
    expectRejected({
      type: 'scatter',
      id: 's',
      runSet: { runIds: [RUN_A] },
      x: 'params.lr',
      y: 'params.batch',
      mode: 'live',
    });
    expectRejected({
      type: 'scatter',
      id: 's',
      runSet: { runIds: [RUN_A] },
      x: 'tags.team',
      y: 'metrics.loss',
      mode: 'live',
    });
  });

  it('ブロック数の上限とidの重複を専用のcodeで拒否する', () => {
    const markdown = (id: string): ReportBlock => ({ type: 'markdown', id, text: '' });
    expect(
      domainErrorCode(() =>
        validateReportBlocks(Array.from({ length: REPORT_MAX_BLOCKS + 1 }, (_, index) => markdown(`b${index}`))),
      ),
    ).toBe('report_too_many_blocks');
    expect(
      domainErrorCode(() =>
        validateReportBlocks(Array.from({ length: REPORT_MAX_BLOCKS }, (_, index) => markdown(`b${index}`))),
      ),
    ).toBeUndefined();
    expect(domainErrorCode(() => validateReportBlocks([markdown('a'), markdown('a')]))).toBe(
      'report_block_id_duplicate',
    );
    const large = Array.from({ length: 11 }, (_, index) => ({
      type: 'markdown' as const,
      id: `b${index}`,
      text: 'あ'.repeat(40_000),
    }));
    expect(domainErrorCode(() => validateReportBlocks(large))).toBe('report_blocks_too_large');
  });

  it('refreshSnapshotBlockIdsはそのバージョンのsnapshotブロックだけを指せる', () => {
    const blocks = [
      { type: 'markdown', id: 'text', text: '' },
      { type: 'chart', id: 'fixed', panel, runSet: { runIds: [RUN_A] }, mode: 'snapshot' },
      { type: 'chart', id: 'live', panel, runSet: { runIds: [RUN_A] }, mode: 'live' },
    ];
    const update = (refreshSnapshotBlockIds: string[]) =>
      reportUpdateSchema.safeParse({ baseRevision: 1, title: 'R', blocks, refreshSnapshotBlockIds });
    expect(update(['fixed']).success).toBe(true);
    expect(update(['live']).success).toBe(false);
    expect(update(['text']).success).toBe(false);
    expect(update(['missing']).success).toBe(false);
  });
});

describe('レポートの参照と内容のhash', () => {
  it('Run集合・media・searchの条件から参照するIDを小文字で重複なく集める', () => {
    const blocks = parseBlocks([
      { type: 'chart', id: 'a', panel, runSet: { runIds: [RUN_A.toUpperCase()] }, mode: 'live' },
      { type: 'media', id: 'b', runIds: [RUN_A, RUN_B], key: 'audio', mode: 'live' },
      { type: 'media_table', id: 'c', runId: RUN_B, mediaId: MEDIA, mode: 'live' },
      { type: 'parameter_importance', id: 'd', runSet: { sweepId: SWEEP }, mode: 'live' },
      {
        type: 'scatter',
        id: 'e',
        runSet: { savedViewId: VIEW },
        x: 'params.lr',
        y: 'metrics.loss',
        mode: 'live',
      },
      {
        type: 'run_table',
        id: 'f',
        runSet: { search: { experimentIds: [EXPERIMENT], parentRunId: RUN_A } },
        columns: [],
        limit: 5,
        mode: 'live',
      },
    ]).data!.blocks;
    expect(collectReportReferences(blocks)).toEqual({
      runIds: [RUN_A, RUN_B],
      sweepIds: [SWEEP],
      savedViewIds: [VIEW],
      experimentIds: [EXPERIMENT],
      modelVersionIds: [],
      datasetVersionIds: [],
      media: [{ runId: RUN_B, mediaId: MEDIA }],
    });
  });

  it('hashはkeyの順序に依らず、内容が変われば変わる', () => {
    const block: ReportBlock = {
      type: 'run_table',
      id: 't',
      runSet: { runIds: [RUN_A] },
      columns: ['metrics.loss'],
      limit: 10,
      mode: 'snapshot',
    };
    const reordered = JSON.parse(
      JSON.stringify({ mode: 'snapshot', limit: 10, columns: ['metrics.loss'], runSet: { runIds: [RUN_A] }, id: 't', type: 'run_table' }),
    ) as ReportBlock;
    expect(reportBlockDigest(reordered)).toBe(reportBlockDigest(block));
    expect(reportBlockDigest({ ...block, limit: 11 })).not.toBe(reportBlockDigest(block));
  });

  it('散布図の軸からparamsとmetricsのkeyを分ける', () => {
    expect(
      scatterTableKeys({ x: 'params.lr', y: 'metrics.loss', color: 'metrics.loss' }),
    ).toEqual({ params: ['lr'], metrics: ['loss'] });
    expect(scatterTableKeys({ x: 'params.a.b', y: 'objective' })).toEqual({
      params: ['a.b'],
      metrics: [],
    });
  });
});
