import { invalidParameter, type SearchLoggedModels } from './validation.js';
import {
  compileFilter,
  splitSearchField,
  SqlParameters,
  type SearchField,
  timestampInMillisecondsSql,
} from './searchSyntax.js';
import {
  loggedModelDatasetCondition,
  loggedModelMetricField,
  loggedModelMetricOrder,
} from './loggedModelMetricSearch.js';

const loggedModelAttributes: Record<string, SearchField> = {
  name: { expression: 'l.name', numeric: false },
  model_id: { expression: 'l.id', numeric: false },
  model_type: { expression: 'l.model_type', numeric: false },
  source_run_id: { expression: 'l.source_run_id::text', numeric: false },
  status: { expression: 'l.status', numeric: false },
  creation_timestamp: {
    expression: timestampInMillisecondsSql('l.created_at'),
    numeric: true,
  },
  creation_time: { expression: timestampInMillisecondsSql('l.created_at'), numeric: true },
  last_updated_timestamp: {
    expression: timestampInMillisecondsSql('l.updated_at'),
    numeric: true,
  },
  last_updated_time: {
    expression: timestampInMillisecondsSql('l.updated_at'),
    numeric: true,
  },
};

export function loggedModelSearch(
  input: SearchLoggedModels,
  projectId: string,
): { parameters: SqlParameters; filter: string; order: string } {
  const parameters = new SqlParameters([projectId, input.experiment_ids]);
  let hasMetricFilter = false;
  const filter = compileFilter({
    filter: input.filter,
    parameters,
    resolveField: (field) => {
      const { kind, key } = splitSearchField(field);
      if (kind === 'metrics') {
        hasMetricFilter = true;
        return loggedModelMetricField(parameters, { key, datasets: input.datasets });
      }
      if (kind === 'params' || kind === 'tags')
        return { expression: `l.${kind}->>${parameters.add(key)}`, numeric: false };
      const attribute = kind === 'attributes' ? loggedModelAttributes[key] : undefined;
      if (!attribute) invalidParameter(`検索field ${field} に対応していません`);
      return attribute;
    },
  });
  const datasetFilter =
    input.datasets.length && !hasMetricFilter
      ? ` AND EXISTS(SELECT 1 FROM mlflow_logged_model_metrics metric WHERE metric.model_id=l.id AND metric.project_id=l.project_id AND ${loggedModelDatasetCondition(parameters, input.datasets)})`
      : '';
  const orders = input.order_by.map((order) => {
    const { kind, key } = splitSearchField(order.field_name);
    if (order.dataset_digest && !order.dataset_name)
      invalidParameter('metric orderのdataset_digestにはdataset_nameが必要です');
    if (kind !== 'metrics' && (order.dataset_name || order.dataset_digest))
      invalidParameter('datasetによるorderはmetricsで指定してください');
    if (kind === 'metrics')
      return loggedModelMetricOrder(parameters, {
        key,
        datasets: order.dataset_name
          ? [{ dataset_name: order.dataset_name, dataset_digest: order.dataset_digest }]
          : [],
        ascending: order.ascending,
      });
    const expression = kind === 'attributes' ? loggedModelAttributes[key]?.expression : undefined;
    if (!expression) invalidParameter(`order field ${order.field_name} に対応していません`);
    return `${expression} ${order.ascending ? 'ASC' : 'DESC'} NULLS LAST`;
  });
  return {
    parameters,
    filter: `${filter}${datasetFilter}`,
    order: [...orders, 'l.created_at DESC', 'l.id ASC'].join(','),
  };
}
