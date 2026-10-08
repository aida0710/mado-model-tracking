import { useId, useMemo, useState } from 'react';
import type { Run, RunGroupBy, RunSearchRequest } from '@mmt/contracts';
import { ChartPanelGrid, type ChartLayoutChange } from './ChartPanelGrid';
import { isCompleteGrouping, RunGroupingControl } from './RunGroupingControl';
import { RunAnalysisPanel } from '../analysis/RunAnalysisPanel';
import { trackingApi } from '../../api/tracking';
import { useChartPanelLayout } from '../../hooks/useChartPanelLayout';
import { useQuery } from '../../hooks/useQuery';
import { createDefaultLayout, setPanelsGroupBy } from '../../lib/chartPanelLayout';
import { getRunChartKeys } from '../../lib/runChartKeys';
import { text, textTemplates } from '../../i18n/catalog';

/** Runs drawn from a search: more lines than this hide each other on one chart. */
export const RUN_LIST_CHART_LIMIT = 50;

type ChartTarget = 'top' | 'selected';
export type RunSearchConditions = Omit<RunSearchRequest, 'limit' | 'cursor'>;

/**
 * Charts above the Run list: the selected Runs or the top of the search, overlaid per panel.
 * A grouping draws each group's mean and range over the whole search instead.
 */
export function RunListCharts({
  projectId,
  conditions,
  selectedIds,
  pageRuns,
}: {
  projectId: string;
  conditions: RunSearchConditions;
  selectedIds: string[];
  pageRuns: readonly Run[];
}) {
  const id = useId();
  const [target, setTarget] = useState<ChartTarget>('top');
  const conditionsKey = JSON.stringify(conditions);
  const topRuns = useQuery(`${projectId}:run-list-charts:${conditionsKey}`, (signal) =>
    trackingApi.searchRuns(projectId, { ...conditions, limit: RUN_LIST_CHART_LIMIT }, signal),
  );
  const topItems = topRuns.value?.items ?? [];
  const knownRuns = useMemo(() => {
    const byId = new Map([...topItems, ...pageRuns].map((run) => [run.id, run]));
    return [...byId.values()];
  }, [topItems, pageRuns]);
  const runIds = target === 'top' ? topItems.map((run) => run.id) : selectedIds;
  const drawnRuns = knownRuns.filter((run) => runIds.includes(run.id));
  const keys = useMemo(() => getRunChartKeys(knownRuns), [knownRuns]);
  const defaultLayout = useMemo(
    () => createDefaultLayout(keys.metricKeys, (index) => `default-${index}`),
    [keys.metricKeys],
  );
  const { layout, isCustomized, updateLayout, resetLayout } = useChartPanelLayout(
    projectId,
    'runList',
    defaultLayout,
  );
  // The grouping of every panel; a tag or param without a key waits here until one is typed.
  const appliedGrouping = layout.panels[0]?.groupBy;
  const [groupingDraft, setGroupingDraft] = useState<RunGroupBy | undefined>();
  const grouping = groupingDraft ?? appliedGrouping;
  function changeGrouping(value: RunGroupBy | undefined) {
    setGroupingDraft(value);
    if (value === undefined || isCompleteGrouping(value))
      updateLayout((current) => setPanelsGroupBy(current, value));
  }
  // New and edited panels follow the grouping chosen for the page.
  const changeLayout: ChartLayoutChange = (change) =>
    updateLayout((current) => setPanelsGroupBy(change(current), appliedGrouping));

  return (
    <div className="run-list-visuals">
      <ChartPanelGrid
        projectId={projectId}
        layout={layout}
        source={{
          runIds,
          // A group covers the whole search; selected Runs are grouped among themselves.
          ...(target === 'top' ? { search: conditions } : {}),
        }}
        runLabels={Object.fromEntries(knownRuns.map((run) => [run.id, run.name]))}
        live={drawnRuns.some((run) => run.status === 'running')}
        metricKeys={keys.metricKeys}
        groupingEnabled
        onLayoutChange={changeLayout}
        {...(isCustomized ? { onResetLayout: resetLayout } : {})}
        toolbar={
          <>
            <label className="toolbar-select" htmlFor={`${id}-target`}>
              <span>{text.chartTarget}</span>
              <select
                id={`${id}-target`}
                value={target}
                onChange={(event) => setTarget(event.target.value as ChartTarget)}
              >
                <option value="top">{textTemplates.chartTopRuns(RUN_LIST_CHART_LIMIT)}</option>
                <option value="selected">{textTemplates.chartSelectedRuns(selectedIds.length)}</option>
              </select>
            </label>
            <RunGroupingControl
              value={grouping}
              tagKeys={keys.tagKeys}
              paramKeys={keys.paramKeys}
              onChange={changeGrouping}
            />
            {isCompleteGrouping(grouping) && (
              <span className="muted">{text.chartGroupingAppliesToAll}</span>
            )}
          </>
        }
      />
      <aside className="run-list-analysis">
        <RunAnalysisPanel projectId={projectId} runSet={{ search: conditions }} />
      </aside>
    </div>
  );
}
