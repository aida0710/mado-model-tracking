import { Link } from 'react-router-dom';
import type { AutomatedRunSummary, ModelAutomationRule } from '@mmt/contracts';
import { DataTable, type TableColumn } from './DataTable';
import { StatusBadge } from './StatusBadge';
import { formatDate } from '../lib/format';
import { formatMetricValue } from '../lib/evaluationComparisonDisplay';
import type { EvaluationSummary, MetricSummaryRow, MetricValueAt } from '../lib/evaluationSummary';
import { text } from '../i18n/catalog';
import { automationText } from '../i18n/automation';
import { deltaSignLabels, modelsTextTemplates } from '../i18n/models';

const metricValueLabels = { notFinite: text.metricNotFinite };

function formatSummaryValue(value: MetricValueAt | null): string {
  return value ? formatMetricValue(value.value, 'present', metricValueLabels) : '—';
}

function formatRunMetric(run: AutomatedRunSummary, metric: string): string {
  const value: unknown = run.latestMetrics[metric];
  if (typeof value !== 'number') return '—';
  return formatMetricValue(value, Number.isFinite(value) ? 'present' : 'not_finite', metricValueLabels);
}

// Automatic evaluations are the ones promotion policies judge, so the mark names the rule.
function OriginBadge({ run, ruleName }: { run: AutomatedRunSummary; ruleName: string | null }) {
  return run.automatic ? (
    <span className="evaluation-origin evaluation-origin-automatic">
      {ruleName ? modelsTextTemplates.automaticByRule(ruleName) : text.evaluationAutomatic}
    </span>
  ) : (
    <span className="evaluation-origin evaluation-origin-manual">{automationText.manual}</span>
  );
}

function MetricSummaryTable({
  projectId,
  summary,
  baselineAlias,
}: {
  projectId: string;
  summary: EvaluationSummary;
  baselineAlias: string | null;
}) {
  const runLink = (value: MetricValueAt | null) =>
    value ? (
      <Link className="mono" to={`/projects/${projectId}/runs/${value.runId}`}>
        {formatSummaryValue(value)}
      </Link>
    ) : (
      '—'
    );
  const baselineColumns: TableColumn<MetricSummaryRow>[] = baselineAlias
    ? [
        {
          key: 'baseline',
          label: modelsTextTemplates.baselineValue(baselineAlias),
          className: 'mono',
          render: (row) => runLink(row.baseline),
        },
        {
          key: 'sign',
          label: text.evaluationDeltaSign,
          render: (row) =>
            row.deltaSign ? (
              <span className={`delta-sign delta-sign-${row.deltaSign}`}>
                {deltaSignLabels[row.deltaSign]}
              </span>
            ) : (
              '—'
            ),
        },
      ]
    : [];
  return (
    <DataTable
      items={summary.rows}
      rowKey={(row) => row.metric}
      empty={text.evaluationSummaryEmpty}
      columns={[
        { key: 'metric', label: text.metricName, render: (row) => row.metric },
        {
          key: 'latest',
          label: text.evaluationLatestValue,
          className: 'mono',
          render: (row) => runLink(row.candidate),
        },
        ...baselineColumns,
      ]}
    />
  );
}

/**
 * The version's evaluation Runs in one table, summary metrics first, each marked as an automatic
 * evaluation (with its rule) or a manual one, above the per-metric latest values and the sign of
 * the difference from the baseline version.
 */
export function EvaluationResultsTable({
  projectId,
  runs,
  rules,
  summary,
  baselineAlias,
}: {
  projectId: string;
  runs: AutomatedRunSummary[];
  rules: ModelAutomationRule[];
  summary: EvaluationSummary;
  baselineAlias: string | null;
}) {
  const ruleName = (run: AutomatedRunSummary) =>
    rules.find((rule) => rule.id === run.ruleId)?.name ?? null;
  const metricColumns: TableColumn<AutomatedRunSummary>[] = summary.metricKeys.map((metric) => ({
    key: `metric:${metric}`,
    label: metric,
    className: 'mono',
    render: (run) => formatRunMetric(run, metric),
  }));
  return (
    <>
      <h3>{text.evaluationSummary}</h3>
      <p className="muted">{text.evaluationSummaryHint}</p>
      <MetricSummaryTable projectId={projectId} summary={summary} baselineAlias={baselineAlias} />
      <h3>{text.evaluationRuns}</h3>
      <DataTable
        items={runs}
        rowKey={(run) => run.id}
        empty={text.evaluationResultsEmpty}
        columns={[
          {
            key: 'name',
            label: text.name,
            render: (run) => <Link to={`/projects/${projectId}/runs/${run.id}`}>{run.name}</Link>,
          },
          {
            key: 'origin',
            label: text.evaluationRule,
            render: (run) => <OriginBadge run={run} ruleName={ruleName(run)} />,
          },
          { key: 'status', label: text.status, render: (run) => <StatusBadge status={run.status} /> },
          {
            key: 'reference',
            label: text.evaluationReferenceSet,
            className: 'mono',
            render: (run) => run.referenceDatasetVersionIds.length || '—',
          },
          {
            key: 'upstream',
            label: text.evaluationUpstreamOutputs,
            className: 'mono',
            render: (run) => run.upstreamDatasetVersionIds.length || '—',
          },
          { key: 'created', label: text.created, render: (run) => formatDate(run.createdAt) },
          ...metricColumns,
        ]}
      />
    </>
  );
}
