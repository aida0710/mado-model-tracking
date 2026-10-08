// The alias compared against when the caller names neither an alias nor a version (decisions.md).
export const DEFAULT_BASELINE_ALIAS = 'production';

// "Reference set" = Run.inputDatasetVersionIds minus Run.upstreamDatasetVersionIds: the fixed
// evaluation data (ground truth, test audio) as opposed to outputs of an upstream Run.
export type EvaluationComparisonStatus =
  | 'ok'
  | 'baseline_missing'
  | 'baseline_not_evaluated'
  | 'candidate_not_evaluated';

// dataset_context: the latest MLflow metric point logged with a reference DatasetVersion digest.
// run_latest: the Run's latestMetrics, which folds every dataset context into one value.
export type MetricValueSource = 'dataset_context' | 'run_latest';

// not_finite covers NaN and ±Infinity, which JSON cannot carry as numbers.
export type MetricValueStatus = 'present' | 'missing' | 'not_finite';

export interface MetricComparison {
  key: string;
  candidate: number | null;
  baseline: number | null;
  candidateStatus: MetricValueStatus;
  baselineStatus: MetricValueStatus;
  // candidate − baseline. null unless both values are present.
  delta: number | null;
  // delta ÷ |baseline|. null when delta is null or the baseline is 0.
  relativeDelta: number | null;
  source: { candidate: MetricValueSource | null; baseline: MetricValueSource | null };
}

export interface EvaluationComparison {
  status: EvaluationComparisonStatus;
  modelId: string;
  candidateVersionId: string;
  // The alias that selected the baseline, or null when baselineVersionId was given directly.
  baselineAlias: string | null;
  baselineVersionId: string | null;
  candidateRunId: string | null;
  baselineRunId: string | null;
  // The conditions both evaluation Runs had to match. Empty/null when they could not be decided.
  referenceDatasetVersionIds: string[];
  codeVersionId: string | null;
  evaluationRuleId: string | null;
  metrics: MetricComparison[];
}
