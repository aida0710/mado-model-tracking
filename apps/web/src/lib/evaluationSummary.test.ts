import { describe, expect, it } from 'vitest';
import type { AutomatedRunSummary } from '@mmt/contracts';
import {
  collectSummaryMetrics,
  deltaSign,
  orderMetricKeys,
  summarizeEvaluations,
} from './evaluationSummary';

function evaluationRun(overrides: Partial<AutomatedRunSummary> & { id: string }): AutomatedRunSummary {
  return {
    name: overrides.id,
    kind: 'evaluation',
    status: 'finished',
    modelVersionId: 'version',
    codeVersionId: 'code-1',
    parentRunId: null,
    latestMetrics: {},
    parameters: {},
    referenceDatasetVersionIds: ['reference'],
    upstreamDatasetVersionIds: [],
    automatic: true,
    ruleId: 'rule',
    executionId: null,
    pipelineRootExecutionId: null,
    createdAt: '2026-10-08T00:00:00.000Z',
    startedAt: null,
    endedAt: '2026-10-08T01:00:00.000Z',
    ...overrides,
  };
}

describe('評価metricの並び', () => {
  it('ruleのsummaryMetricsを指定順で先頭に置き、残りは名前順にする', () => {
    const runs = [evaluationRun({ id: 'a', latestMetrics: { loss: 1, cer: 2, wer: 3 } })];
    expect(orderMetricKeys(runs, ['wer', 'bleu'])).toEqual(['wer', 'bleu', 'cer', 'loss']);
  });

  it('workerのsystem.*は評価の指標ではないので並べない（summaryMetricsで指定したときだけ残す）', () => {
    const runs = [
      evaluationRun({
        id: 'a',
        latestMetrics: { wer: 1, 'system.cpu.percent': 3, 'system/cpu_utilization_percentage': 4, 'system.memory.used_bytes': 5 },
      }),
    ];
    expect(orderMetricKeys(runs, [])).toEqual(['wer']);
    expect(orderMetricKeys(runs, ['system.memory.used_bytes'])).toEqual(['system.memory.used_bytes', 'wer']);
  });

  it('summaryMetricsはRunを作ったruleのものだけを、重複なくrule順に集める', () => {
    const rules = [
      { id: 'rule-1', summaryMetrics: ['wer', 'cer'] },
      { id: 'rule-2', summaryMetrics: ['cer', 'mos'] },
      { id: 'unused', summaryMetrics: ['bleu'] },
    ];
    const runs = [{ ruleId: 'rule-2' }, { ruleId: null }, { ruleId: 'rule-1' }];
    expect(collectSummaryMetrics(runs, rules)).toEqual(['wer', 'cer', 'mos']);
  });
});

describe('評価結果の集約', () => {
  it('同名metricは終了時刻が新しい成功Runの値を使い、実行中・失敗・推論のRunは使わない', () => {
    const summary = summarizeEvaluations({
      candidateRuns: [
        evaluationRun({ id: 'old', latestMetrics: { wer: 0.3 }, endedAt: '2026-10-08T01:00:00Z' }),
        evaluationRun({ id: 'new', latestMetrics: { wer: 0.2 }, endedAt: '2026-10-08T02:00:00Z' }),
        evaluationRun({ id: 'running', status: 'running', latestMetrics: { wer: 0.1 }, endedAt: null }),
        evaluationRun({ id: 'failed', status: 'failed', latestMetrics: { wer: 0.05 } }),
        evaluationRun({ id: 'inference', kind: 'inference', latestMetrics: { wer: 0.01 } }),
      ],
      baselineRuns: [],
      summaryMetrics: [],
    });
    expect(summary.rows).toEqual([
      { metric: 'wer', candidate: { value: 0.2, runId: 'new' }, baseline: null, deltaSign: null },
    ]);
  });

  it('基準版との差の符号は同じ評価条件の基準Runと比べ、条件が違う基準Runは使わない', () => {
    const summary = summarizeEvaluations({
      candidateRuns: [evaluationRun({ id: 'candidate', latestMetrics: { wer: 0.2, cer: 0.1, mos: 4 } })],
      baselineRuns: [
        evaluationRun({
          id: 'other-code',
          codeVersionId: 'code-2',
          latestMetrics: { wer: 0.9 },
          endedAt: '2026-10-08T05:00:00Z',
        }),
        evaluationRun({ id: 'baseline', latestMetrics: { wer: 0.25, cer: 0.1, mos: 3.5 } }),
      ],
      summaryMetrics: ['wer'],
    });
    expect(summary.metricKeys).toEqual(['wer', 'cer', 'mos']);
    expect(summary.rows.map((row) => [row.metric, row.baseline?.runId, row.deltaSign])).toEqual([
      ['wer', 'baseline', 'negative'],
      ['cer', 'baseline', 'zero'],
      ['mos', 'baseline', 'positive'],
    ]);
  });

  it('欠損は補完せず、片側が無いmetricや数値でない値は空のままにする', () => {
    const summary = summarizeEvaluations({
      candidateRuns: [evaluationRun({ id: 'candidate', latestMetrics: { wer: 0.2, nan: Number.NaN } })],
      baselineRuns: [evaluationRun({ id: 'baseline', latestMetrics: { cer: 0.1 } })],
      summaryMetrics: ['bleu'],
    });
    expect(summary.rows).toEqual([
      { metric: 'bleu', candidate: null, baseline: null, deltaSign: null },
      { metric: 'nan', candidate: null, baseline: null, deltaSign: null },
      { metric: 'wer', candidate: { value: 0.2, runId: 'candidate' }, baseline: null, deltaSign: null },
    ]);
  });

  it('正解セットは順序を問わず同じ条件とみなす', () => {
    const summary = summarizeEvaluations({
      candidateRuns: [
        evaluationRun({ id: 'candidate', referenceDatasetVersionIds: ['b', 'a'], latestMetrics: { wer: 1 } }),
      ],
      baselineRuns: [
        evaluationRun({ id: 'baseline', referenceDatasetVersionIds: ['a', 'b'], latestMetrics: { wer: 2 } }),
      ],
      summaryMetrics: [],
    });
    expect(summary.rows[0]?.deltaSign).toBe('negative');
  });

  it('差の符号は大小だけで決まる', () => {
    expect(deltaSign(1, 0)).toBe('positive');
    expect(deltaSign(-1, 0)).toBe('negative');
    expect(deltaSign(0.5, 0.5)).toBe('zero');
  });
});
