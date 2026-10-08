import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import {
  RUN_COMPARISON_MAX_RUNS,
  RUN_COMPARISON_MIN_RUNS,
  type Run,
  type RunComparison,
} from '@mmt/contracts';
import { useProject } from '../hooks/useProject';
import { useRunComparison } from '../hooks/useRunComparison';
import { trackingApi } from '../api/tracking';
import { Empty, Resource } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { MetricsChart } from '../components/MetricsChart';
import { ArtifactCompare } from '../components/ArtifactCompare';
import { Tabs } from '../components/Tabs';
import { StatusBadge } from '../components/StatusBadge';
import { formatValue } from '../lib/format';
import { formatDelta, formatRelativeDelta } from '../lib/evaluationComparisonDisplay';
import {
  buildComparisonTableRows,
  chooseBaselineRunId,
  comparisonChartSeries,
  filterComparisonRows,
  isComparableRunCount,
  parseComparedRunIds,
  type ComparisonTableRow,
} from '../lib/comparisonRows';
import { text, textTemplates } from '../i18n/catalog';

// URL parameters, so a comparison with its baseline can be shared as a link.
const RUNS_PARAM = 'runs';
const BASELINE_PARAM = 'baseline';

const rowGroupLabels: Record<ComparisonTableRow['group'], string> = {
  modelVersion: text.comparisonModelVersion,
  datasetVersions: text.comparisonDatasetVersions,
  params: text.parameters,
  metrics: text.metrics,
  tags: text.tags,
};

export function ComparePage() {
  const { project } = useProject();
  const [params, setParams] = useSearchParams();
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const tab = params.get('tab') === 'artifacts' ? 'artifacts' : 'details';
  const runIds = parseComparedRunIds(params.get(RUNS_PARAM));
  const baselineRunId = chooseBaselineRunId(runIds, params.get(BASELINE_PARAM));
  const comparison = useRunComparison({
    projectId: project.id,
    runIds,
    baselineRunId,
  });
  function updateParam(name: string, value: string | null) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );
  }
  return (
    <section className="page">
      <PageHeader
        title={text.compare}
        eyebrow={<Link to={`/projects/${project.id}/experiments`}>{text.experiments}</Link>}
        actions={
          isComparableRunCount(runIds.length) && (
            <a
              className="button"
              href={trackingApi.runComparisonCsvUrl(project.id, {
                runIds,
                baselineRunId,
              })}
              download
            >
              <Download size={15} />
              {text.comparisonDownloadCsv}
            </a>
          )
        }
      />
      <Tabs
        tabs={[
          { key: 'details', label: text.details },
          { key: 'artifacts', label: text.artifacts },
        ]}
        selected={tab}
        onSelect={(key) => updateParam('tab', key === 'artifacts' ? key : null)}
        panelId="compare-tab-panel"
      />
      <div id="compare-tab-panel" role="tabpanel">
        {!isComparableRunCount(runIds.length) ? (
          <Empty>
            {textTemplates.comparisonRunCountOutOfRange(
              RUN_COMPARISON_MIN_RUNS,
              RUN_COMPARISON_MAX_RUNS,
            )}
          </Empty>
        ) : (
          <Resource query={comparison}>
            {(value) =>
              tab === 'artifacts' ? (
                <ArtifactCompare projectId={project.id} runs={value.runs} />
              ) : (
                <ComparisonDetails
                  projectId={project.id}
                  comparison={value}
                  onlyDifferences={onlyDifferences}
                  onOnlyDifferencesChange={setOnlyDifferences}
                  onBaselineChange={(runId) => updateParam(BASELINE_PARAM, runId)}
                />
              )
            }
          </Resource>
        )}
      </div>
    </section>
  );
}

function ComparisonDetails({
  projectId,
  comparison,
  onlyDifferences,
  onOnlyDifferencesChange,
  onBaselineChange,
}: {
  projectId: string;
  comparison: RunComparison;
  onlyDifferences: boolean;
  onOnlyDifferencesChange: (onlyDifferences: boolean) => void;
  onBaselineChange: (runId: string | null) => void;
}) {
  const { runs, baselineRunId } = comparison;
  const rows = filterComparisonRows(buildComparisonTableRows(comparison), onlyDifferences);
  return (
    <>
      <MetricsChart series={comparisonChartSeries(comparison)} />
      <div className="run-toolbar">
        <label className="toolbar-select">
          <span>{text.comparisonBaselineRun}</span>
          <select
            aria-label={text.comparisonBaselineRun}
            value={baselineRunId ?? ''}
            onChange={(event) => onBaselineChange(event.target.value || null)}
          >
            <option value="">{text.comparisonNoBaseline}</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.name}
              </option>
            ))}
          </select>
        </label>
        <label className="toolbar-select">
          <input
            type="checkbox"
            checked={onlyDifferences}
            onChange={(event) => onOnlyDifferencesChange(event.target.checked)}
          />
          <span>{text.comparisonOnlyDifferences}</span>
        </label>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{text.details}</th>
              {runs.map((run) => (
                <th key={run.id}>
                  <Link to={`/projects/${projectId}/runs/${run.id}`}>{run.name}</Link>
                  {run.id === baselineRunId && <small>{text.comparisonBaselineMarker}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <StatusRow runs={runs} />
            {rows.map((row) => (
              <tr key={row.id}>
                <th>
                  <small>{rowGroupLabels[row.group]}</small>
                  {row.key}
                </th>
                {row.values.map((value, index) => (
                  <td key={runs[index]!.id} className="mono">
                    {formatValue(value)}
                    {row.deltas && runs[index]!.id !== baselineRunId && (
                      <small>
                        {formatDelta(row.deltas[index]!.delta)} (
                        {formatRelativeDelta(row.deltas[index]!.relativeDelta)})
                      </small>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {onlyDifferences && !rows.length && <Empty>{text.comparisonNoDifferences}</Empty>}
    </>
  );
}

function StatusRow({ runs }: { runs: Run[] }) {
  return (
    <tr>
      <th>{text.status}</th>
      {runs.map((run) => (
        <td key={run.id}>
          <StatusBadge status={run.status} />
        </td>
      ))}
    </tr>
  );
}
