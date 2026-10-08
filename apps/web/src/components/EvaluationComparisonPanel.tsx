import { Link } from 'react-router-dom';
import type {
  EvaluationComparison,
  EvaluationComparisonStatus,
  MetricComparison,
  MetricValueSource,
  Model,
} from '@mmt/contracts';
import type { useEvaluationComparison } from '../hooks/useEvaluationComparison';
import {
  formatDelta,
  formatMetricValue,
  formatRelativeDelta,
} from '../lib/evaluationComparisonDisplay';
import { text } from '../i18n/catalog';
import { DataTable } from './DataTable';
import { Resource } from './Feedback';
import { DetailsList } from './JsonDetails';

const statusMessages: Record<Exclude<EvaluationComparisonStatus, 'ok'>, string> = {
  baseline_missing: text.comparisonBaselineMissing,
  baseline_not_evaluated: text.comparisonBaselineNotEvaluated,
  candidate_not_evaluated: text.comparisonCandidateNotEvaluated,
};

const sourceLabels: Record<MetricValueSource, string> = {
  dataset_context: text.metricSourceDatasetContext,
  run_latest: text.metricSourceRunLatest,
};

function RunLink({ projectId, runId }: { projectId: string; runId: string | null }) {
  if (!runId) return <>—</>;
  return (
    <Link className="mono" to={`/projects/${projectId}/runs/${runId}`}>
      {runId}
    </Link>
  );
}

function ComparisonConditions({
  projectId,
  comparison,
}: {
  projectId: string;
  comparison: EvaluationComparison;
}) {
  return (
    <DetailsList
      entries={[
        [
          text.baselineVersion,
          comparison.baselineVersionId ? (
            <Link
              className="mono"
              to={`/projects/${projectId}/models?version=${comparison.baselineVersionId}`}
            >
              {comparison.baselineVersionId}
            </Link>
          ) : (
            '—'
          ),
        ],
        [
          text.referenceDatasets,
          comparison.referenceDatasetVersionIds.length
            ? comparison.referenceDatasetVersionIds.map((id) => (
                <span className="mono version-link" key={id}>
                  {id}
                </span>
              ))
            : text.noReferenceDatasets,
        ],
        [
          text.evaluationCodeVersion,
          <span className="mono">{comparison.codeVersionId ?? '—'}</span>,
        ],
        [
          text.evaluationRule,
          <span className="mono">{comparison.evaluationRuleId ?? text.none}</span>,
        ],
        [
          text.candidateEvaluationRun,
          <RunLink projectId={projectId} runId={comparison.candidateRunId} />,
        ],
        [
          text.baselineEvaluationRun,
          <RunLink projectId={projectId} runId={comparison.baselineRunId} />,
        ],
      ]}
    />
  );
}

const metricValueLabels = { notFinite: text.metricNotFinite };

function describeSources(source: MetricComparison['source']): string {
  const labels = [source.candidate, source.baseline].map((value) =>
    value ? sourceLabels[value] : '—',
  );
  return labels[0] === labels[1] ? labels[0]! : `${labels[0]} / ${labels[1]}`;
}

// Differences are shown without good/bad colouring: whether higher is better is defined by
// promotion policies, not by this panel.
function MetricComparisonTable({ metrics }: { metrics: MetricComparison[] }) {
  return (
    <DataTable
      items={metrics}
      rowKey={(metric) => metric.key}
      empty={text.noComparedMetrics}
      columns={[
        { key: 'name', label: text.metricName, render: (metric) => metric.key },
        {
          key: 'candidate',
          label: text.metricCandidate,
          className: 'mono',
          render: (metric) =>
            formatMetricValue(metric.candidate, metric.candidateStatus, metricValueLabels),
        },
        {
          key: 'baseline',
          label: text.metricBaseline,
          className: 'mono',
          render: (metric) =>
            formatMetricValue(metric.baseline, metric.baselineStatus, metricValueLabels),
        },
        {
          key: 'delta',
          label: text.metricDelta,
          className: 'mono',
          render: (metric) => formatDelta(metric.delta),
        },
        {
          key: 'relative-delta',
          label: text.metricRelativeDelta,
          className: 'mono',
          render: (metric) => formatRelativeDelta(metric.relativeDelta),
        },
        { key: 'source', label: text.metricSource, render: (metric) => describeSources(metric.source) },
      ]}
    />
  );
}

/**
 * Compares a model version's latest evaluation with the evaluation of the version a baseline alias
 * points to, under the same reference set and evaluation code. Placed on a page by its owner.
 */
export function EvaluationComparisonPanel({
  projectId,
  model,
  evaluationComparison,
}: {
  projectId: string;
  model: Pick<Model, 'aliases'>;
  // From useEvaluationComparison on the page, so that the page's reload refreshes it.
  evaluationComparison: ReturnType<typeof useEvaluationComparison>;
}) {
  const { baselineAlias, selectBaselineAlias, comparison } = evaluationComparison;
  const aliasNames = Object.keys(model.aliases).sort();
  return (
    <section className="automation-panel" aria-label={text.evaluationComparison}>
      <div className="section-heading">
        <h2>{text.evaluationComparison}</h2>
      </div>
      <label className="field">
        <span>{text.baselineAlias}</span>
        <select
          value={baselineAlias ?? ''}
          disabled={!aliasNames.length}
          onChange={(event) => selectBaselineAlias(event.target.value)}
        >
          {!aliasNames.length && <option value="">{text.noModelAliases}</option>}
          {aliasNames.map((alias) => (
            <option key={alias} value={alias}>
              {alias}
            </option>
          ))}
        </select>
      </label>
      <Resource query={comparison}>
        {(value) => (
          <>
            {value.status !== 'ok' && (
              <div className="notice" role="status">
                <span>{statusMessages[value.status]}</span>
              </div>
            )}
            <h3>{text.comparisonConditions}</h3>
            <ComparisonConditions projectId={projectId} comparison={value} />
            <MetricComparisonTable metrics={value.metrics} />
          </>
        )}
      </Resource>
    </section>
  );
}
