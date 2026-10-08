import type { AutomatedRunSummary, ModelAutomationRule } from '@mmt/contracts';
import { isSystemMetricKey } from './systemMetricKeys';

type EvaluationRun = Pick<
  AutomatedRunSummary,
  | 'id'
  | 'kind'
  | 'status'
  | 'latestMetrics'
  | 'codeVersionId'
  | 'referenceDatasetVersionIds'
  | 'ruleId'
  | 'createdAt'
  | 'endedAt'
>;

export type DeltaSign = 'positive' | 'negative' | 'zero';

export interface MetricValueAt {
  value: number;
  runId: string;
}

export interface MetricSummaryRow {
  metric: string;
  candidate: MetricValueAt | null;
  // The baseline version's value under the same evaluation conditions as the candidate's value.
  baseline: MetricValueAt | null;
  // Sign of candidate − baseline. Whether higher is better is left to promotion policies.
  deltaSign: DeltaSign | null;
}

export interface EvaluationSummary {
  metricKeys: string[];
  rows: MetricSummaryRow[];
}

// Only finished evaluation Runs count: a running Run's latest metrics are still partial.
export function finishedEvaluationRuns<T extends EvaluationRun>(runs: readonly T[]): T[] {
  return runs
    .filter((run) => run.kind === 'evaluation' && run.status === 'finished')
    .sort(compareNewestFirst);
}

function compareNewestFirst(left: EvaluationRun, right: EvaluationRun): number {
  return (
    (right.endedAt ?? '').localeCompare(left.endedAt ?? '') ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

// Two evaluations are comparable when they used the same evaluation code and reference set,
// the same conditions the API's baseline comparison matches on.
export function evaluationConditionKey(
  run: Pick<EvaluationRun, 'codeVersionId' | 'referenceDatasetVersionIds'>,
): string {
  return JSON.stringify([run.codeVersionId, [...run.referenceDatasetVersionIds].sort()]);
}

// NaN and infinities cannot be compared, so they are treated as missing rather than replaced.
function metricValue(run: EvaluationRun, metric: string): number | null {
  const value: unknown = run.latestMetrics[metric];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The summary metrics of the rules behind the Runs, in rule order, without duplicates. */
export function collectSummaryMetrics(
  runs: readonly Pick<EvaluationRun, 'ruleId'>[],
  rules: readonly Pick<ModelAutomationRule, 'id' | 'summaryMetrics'>[],
): string[] {
  const ruleIds = new Set(runs.map((run) => run.ruleId).filter((id) => id !== null));
  return [
    ...new Set(
      rules.filter((rule) => ruleIds.has(rule.id)).flatMap((rule) => rule.summaryMetrics),
    ),
  ];
}

/**
 * Summary metrics first in their given order, then every other metric name alphabetically. The
 * worker's system metrics (system.cpu.percent, …) describe the machine, not the evaluation, so they
 * are left out unless a rule names them as summary metrics.
 */
export function orderMetricKeys(
  runs: readonly Pick<EvaluationRun, 'latestMetrics'>[],
  summaryMetrics: readonly string[],
): string[] {
  const prioritized = new Set(summaryMetrics);
  const others = new Set(
    runs
      .flatMap((run) => Object.keys(run.latestMetrics))
      .filter((key) => !prioritized.has(key) && !isSystemMetricKey(key)),
  );
  return [...summaryMetrics, ...[...others].sort()];
}

function latestValue(
  runs: readonly EvaluationRun[],
  request: { metric: string; conditionKey?: string },
): (MetricValueAt & { conditionKey: string }) | null {
  for (const run of runs) {
    const conditionKey = evaluationConditionKey(run);
    if (request.conditionKey !== undefined && conditionKey !== request.conditionKey) continue;
    const value = metricValue(run, request.metric);
    if (value !== null) return { value, runId: run.id, conditionKey };
  }
  return null;
}

export function deltaSign(candidate: number, baseline: number): DeltaSign {
  if (candidate > baseline) return 'positive';
  if (candidate < baseline) return 'negative';
  return 'zero';
}

/**
 * For each metric, the newest finished evaluation of the candidate that recorded it, and the
 * newest finished evaluation of the baseline under the same conditions. A metric with no value on
 * one side stays empty; nothing is taken from other conditions or filled in.
 */
export function summarizeEvaluations(input: {
  candidateRuns: readonly EvaluationRun[];
  baselineRuns: readonly EvaluationRun[];
  summaryMetrics: readonly string[];
}): EvaluationSummary {
  const candidates = finishedEvaluationRuns(input.candidateRuns);
  const baselines = finishedEvaluationRuns(input.baselineRuns);
  const metricKeys = orderMetricKeys(candidates, input.summaryMetrics);
  const rows = metricKeys.map((metric): MetricSummaryRow => {
    const candidate = latestValue(candidates, { metric });
    const baseline = candidate
      ? latestValue(baselines, { metric, conditionKey: candidate.conditionKey })
      : null;
    return {
      metric,
      candidate: candidate && { value: candidate.value, runId: candidate.runId },
      baseline: baseline && { value: baseline.value, runId: baseline.runId },
      deltaSign: candidate && baseline ? deltaSign(candidate.value, baseline.value) : null,
    };
  });
  return { metricKeys, rows };
}
