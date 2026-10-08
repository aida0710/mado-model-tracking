import type { SearchLoggedModels } from './validation.js';
import type { SearchField, SqlParameters } from './searchSyntax.js';

// PostgreSQL treats NaN as greater than numbers; use explicit IEEE comparisons and sort ranks.
const NAN_SQL = "'NaN'::double precision";
const metricSortRank = { value: 0, nan: 1, missing: 2 } as const;

export function loggedModelDatasetCondition(
  parameters: SqlParameters,
  datasets: SearchLoggedModels['datasets'],
): string {
  if (!datasets.length) return 'TRUE';
  return `(${datasets
    .map((dataset) => {
      const name = `metric.dataset_name=${parameters.add(dataset.dataset_name)}`;
      return dataset.dataset_digest
        ? `(${name} AND metric.dataset_digest=${parameters.add(dataset.dataset_digest)})`
        : name;
    })
    .join(' OR ')})`;
}

export function loggedModelMetricField(
  parameters: SqlParameters,
  filter: { key: string; datasets: SearchLoggedModels['datasets'] },
): SearchField {
  const key = parameters.add(filter.key);
  const dataset = loggedModelDatasetCondition(parameters, filter.datasets);
  const expression = 'metric.value';
  return {
    expression,
    numeric: true,
    compileComparison: ({ operator, valueParameter }) => {
      const comparison = `${expression} ${operator} ${valueParameter}`;
      // A model matches when any saved point satisfies this clause, including older evaluations.
      const valueCondition =
        operator === '!='
          ? `(${expression}=${NAN_SQL} OR ${comparison})`
          : `(${expression}<>${NAN_SQL} AND ${comparison})`;
      return `EXISTS(SELECT 1 FROM mlflow_logged_model_metrics metric
        WHERE metric.project_id=l.project_id AND metric.model_id=l.id AND metric.key=${key}
        AND ${dataset} AND ${valueCondition})`;
    },
  };
}

export function loggedModelMetricOrder(
  parameters: SqlParameters,
  order: { key: string; datasets: SearchLoggedModels['datasets']; ascending: boolean },
): string {
  const key = parameters.add(order.key);
  const dataset = loggedModelDatasetCondition(parameters, order.datasets);
  // Logged Model evaluation recency is timestamp first, unlike Run latest metrics' step first.
  const expression = `(SELECT metric.value FROM mlflow_logged_model_metrics metric
    WHERE metric.project_id=l.project_id AND metric.model_id=l.id AND metric.key=${key} AND ${dataset}
    ORDER BY metric.timestamp_ms DESC,metric.step DESC,metric.run_id ASC,metric.id ASC LIMIT 1)`;
  return `CASE WHEN ${expression}=${NAN_SQL} THEN ${metricSortRank.nan}
    WHEN ${expression} IS NULL THEN ${metricSortRank.missing} ELSE ${metricSortRank.value} END ASC,
    ${expression} ${order.ascending ? 'ASC' : 'DESC'} NULLS LAST`;
}
