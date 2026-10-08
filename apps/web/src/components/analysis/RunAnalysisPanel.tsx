import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RunAnalysisPanelProps } from '../charts/chartProps';
import { text, textTemplates } from '../../i18n/catalog';
import { useRunAnalysis } from '../../hooks/useRunAnalysis';
import {
  analysisRows,
  type AnalysisTarget,
  defaultParamAxisKeys,
  metricFieldKey,
  metricFields,
  OBJECTIVE_FIELD_KEY,
  paramFields,
} from '../../lib/runAnalysisFields';
import { ErrorNotice, Empty, Loading } from '../Feedback';
import { Tabs } from '../Tabs';
import { ParallelCoordinatesChart } from './ParallelCoordinatesChart';
import { ParameterImportanceTable } from './ParameterImportanceTable';
import { ParamScatterChart } from './ParamScatterChart';

type AnalysisTab = 'parallel' | 'importance' | 'scatter';
// The selected-Run list under the chart stays short; the page's own list shows them all.
const SELECTED_RUN_PREVIEW_COUNT = 20;
const SWEEP_OBJECTIVE_OPTION = '';

export interface RunAnalysisPanelOptions extends RunAnalysisPanelProps {
  /** Run IDs inside the parallel coordinates brushes, e.g. to select them in the Run list. */
  onSelectionChange?: (runIds: string[]) => void;
}

function targetFieldKey(target: AnalysisTarget): string {
  return target.source === 'sweep_objective' ? OBJECTIVE_FIELD_KEY : metricFieldKey(target.metric);
}

/** Parallel coordinates, parameter importance and a scatter plot over one set of Runs. */
export function RunAnalysisPanel({ projectId, runSet, onSelectionChange }: RunAnalysisPanelOptions) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<AnalysisTab>('parallel');
  const [chosenTarget, setChosenTarget] = useState<AnalysisTarget | null>(null);
  // null follows the default (most important params); a list is the user's own choice.
  const [chosenParamAxes, setChosenParamAxes] = useState<string[] | null>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<string[] | null>(null);

  const tooFewRuns = 'runIds' in runSet && runSet.runIds.length < 2;
  const { metricOptions, target, table, importance } = useRunAnalysis({ projectId, runSet, chosenTarget });
  const options = metricOptions.value;

  const tableValue = table.value;
  const rows = useMemo(() => (tableValue ? analysisRows(tableValue) : []), [tableValue]);
  const params = useMemo(() => (tableValue ? paramFields(tableValue) : []), [tableValue]);
  const metrics = useMemo(
    () => (tableValue ? metricFields(tableValue, text.analysisSweepObjective) : []),
    [tableValue],
  );
  const paramAxisKeys = useMemo(
    () => chosenParamAxes ?? (tableValue ? defaultParamAxisKeys(tableValue, importance.value) : []),
    [chosenParamAxes, tableValue, importance.value],
  );
  const targetKey = target ? targetFieldKey(target) : null;
  const parallelAxes = useMemo(() => {
    const shownParams = paramAxisKeys.flatMap((key) => params.find((param) => param.key === key) ?? []);
    const targetAxis = metrics.find((metric) => metric.key === targetKey);
    return targetAxis ? [...shownParams, targetAxis] : shownParams;
  }, [paramAxisKeys, params, metrics, targetKey]);

  if (tooFewRuns) return <Empty>{text.analysisTooFewRuns}</Empty>;
  if (metricOptions.error) return <ErrorNotice message={metricOptions.error} retry={metricOptions.reload} />;
  if (!options) return <Loading />;
  if (options.metricKeys.length === 0) return <Empty>{text.analysisNoMetrics}</Empty>;

  function handleSelectionChange(runIds: string[]) {
    setSelectedRunIds(runIds);
    onSelectionChange?.(runIds);
  }

  const runDetailPath = (runId: string) =>
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;
  const targetValue = !target || target.source === 'sweep_objective' ? SWEEP_OBJECTIVE_OPTION : target.metric;
  const narrowed = selectedRunIds !== null && selectedRunIds.length < rows.length ? selectedRunIds : null;
  const runNames = new Map(rows.map((row) => [row.runId, row.name]));

  return (
    <section className="analysis-panel" aria-label={text.analysisTitle}>
      <div className="analysis-panel-controls">
        <label className="chart-selector">
          <span>{text.analysisTarget}</span>
          <select
            aria-label={text.analysisTarget}
            value={targetValue}
            onChange={(event) =>
              setChosenTarget(
                event.target.value === SWEEP_OBJECTIVE_OPTION
                  ? { source: 'sweep_objective' }
                  : { source: 'latest_metric', metric: event.target.value },
              )
            }
          >
            {options.objectiveMetric && (
              <option value={SWEEP_OBJECTIVE_OPTION}>
                {`${text.analysisSweepObjective} (${options.objectiveMetric})`}
              </option>
            )}
            {options.metricKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        {params.length > 0 && (
          <details className="column-menu analysis-axis-menu">
            <summary>
              {text.analysisAxes} {textTemplates.analysisAxisCount(paramAxisKeys.length, params.length)}
            </summary>
            <div className="popover">
              {params.map((param) => (
                <label key={param.key}>
                  <input
                    type="checkbox"
                    checked={paramAxisKeys.includes(param.key)}
                    onChange={(event) =>
                      setChosenParamAxes(
                        event.target.checked
                          ? [...paramAxisKeys, param.key]
                          : paramAxisKeys.filter((key) => key !== param.key),
                      )
                    }
                  />
                  {param.label}
                </label>
              ))}
            </div>
          </details>
        )}
      </div>
      <Tabs
        tabs={[
          { key: 'parallel', label: text.analysisParallel },
          { key: 'importance', label: text.analysisImportance },
          { key: 'scatter', label: text.analysisScatter },
        ]}
        selected={tab}
        onSelect={(key) => setTab(key as AnalysisTab)}
        panelId="analysis-tab-panel"
      />
      <div id="analysis-tab-panel" role="tabpanel" className="analysis-tab-panel">
        {tab === 'importance' ? (
          importance.error ? (
            <ErrorNotice message={importance.error} retry={importance.reload} />
          ) : importance.value ? (
            <ParameterImportanceTable result={importance.value} />
          ) : (
            <Loading />
          )
        ) : table.error ? (
          <ErrorNotice message={table.error} retry={table.reload} />
        ) : !tableValue ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>{text.analysisNoRuns}</Empty>
        ) : tab === 'parallel' ? (
          <>
            <ParallelCoordinatesChart
              rows={rows}
              axes={parallelAxes}
              colorAxisKey={targetKey}
              onSelectionChange={handleSelectionChange}
            />
            {narrowed && (
              <div className="analysis-selected-runs">
                <strong>{text.analysisSelectedRuns}</strong>
                <ul data-testid="analysis-selected-runs">
                  {narrowed.slice(0, SELECTED_RUN_PREVIEW_COUNT).map((runId) => (
                    <li key={runId}>
                      <Link to={runDetailPath(runId)}>
                        {runNames.get(runId) ?? runId}
                      </Link>
                    </li>
                  ))}
                  {narrowed.length > SELECTED_RUN_PREVIEW_COUNT && (
                    <li>{textTemplates.analysisMoreSelectedRuns(narrowed.length - SELECTED_RUN_PREVIEW_COUNT)}</li>
                  )}
                </ul>
              </div>
            )}
          </>
        ) : (
          <ParamScatterChart
            rows={rows}
            fields={[...params, ...metrics]}
            defaultX={paramAxisKeys[0]}
            defaultY={targetKey ?? undefined}
            onRunClick={(runId) => navigate(runDetailPath(runId))}
          />
        )}
      </div>
    </section>
  );
}
