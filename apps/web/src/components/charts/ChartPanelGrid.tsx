import { useState, type CSSProperties, type ReactNode } from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import type { ChartPanelLayout, ChartXAxis } from '@mmt/contracts';
import { CHART_ROW_HEIGHT_PX, ChartPanel } from './ChartPanel';
import type { MetricsChartMarker } from './chartProps';
import { ChartPanelEditor, type ChartGroupingOptions } from './ChartPanelEditor';
import { Empty } from '../Feedback';
import { useChartPanelData, type ChartRunSource } from '../../hooks/useChartPanelData';
import { planChartRequests } from '../../lib/chartPanelRequests';
import {
  addPanel,
  createPanelConfig,
  movePanel,
  removePanel,
  resizePanel,
  updatePanel,
} from '../../lib/chartPanelLayout';
import { text } from '../../i18n/catalog';

/** Unique within a layout; crypto.randomUUID is missing on plain-http origins. */
function createPanelId(): string {
  return `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Applies a change to the layout; the page decides where the result is kept. */
export type ChartLayoutChange = (change: (layout: ChartPanelLayout) => ChartPanelLayout) => void;

/**
 * Panels on the 12-column grid. Every panel of the page is fetched with one request per x axis
 * and grouping, then each panel draws its keys. Without `onLayoutChange` the panels are fixed but
 * their charts can still be zoomed.
 */
export function ChartPanelGrid({
  projectId,
  layout,
  source,
  runLabels,
  live,
  metricKeys,
  grouping,
  groupingEnabled = grouping !== undefined,
  markersFor,
  valueScale,
  onLayoutChange,
  onResetLayout,
  toolbar,
  emptyMessage,
}: {
  projectId: string;
  layout: ChartPanelLayout;
  source: ChartRunSource;
  runLabels: Readonly<Record<string, string>>;
  live: boolean;
  metricKeys: readonly string[];
  /** Offered in the panel editor, so each panel can group Runs its own way. */
  grouping?: ChartGroupingOptions;
  /** Draws stored groupings even without per-panel choices (the Run list sets one for all). */
  groupingEnabled?: boolean;
  markersFor?: (xAxis: ChartXAxis) => MetricsChartMarker[];
  valueScale?: (key: string) => number;
  onLayoutChange?: ChartLayoutChange;
  /** Shown only when the user has changed the default. */
  onResetLayout?: () => void;
  toolbar?: ReactNode;
  /** Shown without panels; by default it tells whether the Runs have metrics at all. */
  emptyMessage?: string;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const shared = useChartPanelData({
    projectId,
    source,
    plans: planChartRequests(layout.panels, groupingEnabled),
    live,
  });
  const gridStyle = { '--chart-row-height': `${CHART_ROW_HEIGHT_PX}px` } as CSSProperties;

  return (
    <section className="chart-panel-area" aria-label={text.charts}>
      {(toolbar || onLayoutChange) && (
        <div className="chart-grid-toolbar">
          {toolbar}
          {onLayoutChange && (
            <div className="chart-grid-actions">
              {onResetLayout && (
                <button type="button" className="button small" onClick={onResetLayout}>
                  <RotateCcw size={14} />
                  {text.resetChartLayout}
                </button>
              )}
              <button
                type="button"
                className="button small"
                disabled={!metricKeys.length}
                onClick={() => setIsAdding(true)}
              >
                <Plus size={14} />
                {text.addChart}
              </button>
            </div>
          )}
        </div>
      )}
      {!source.runIds.length && !source.search ? (
        <Empty>{text.chartNoRuns}</Empty>
      ) : !layout.panels.length ? (
        <Empty>{emptyMessage ?? (metricKeys.length ? text.noChartPanels : text.noChartMetrics)}</Empty>
      ) : (
        <div className="chart-panel-grid" style={gridStyle}>
          {layout.panels.map((panel) => (
            <div
              key={panel.id}
              className="chart-panel-cell"
              style={{
                gridColumn: `${panel.layout.x + 1} / span ${panel.layout.w}`,
                gridRow: `${panel.layout.y + 1} / span ${panel.layout.h}`,
              }}
            >
              <ChartPanel
                projectId={projectId}
                config={panel}
                runIds={source.runIds}
                {...(source.search ? { search: source.search } : {})}
                runLabels={runLabels}
                live={live}
                shared={shared}
                metricKeys={metricKeys}
                {...(grouping ? { grouping } : {})}
                groupingEnabled={groupingEnabled}
                {...(markersFor ? { markersFor } : {})}
                {...(valueScale ? { valueScale } : {})}
                {...(onLayoutChange
                  ? {
                      onConfigChange: (config) =>
                        onLayoutChange((current) => updatePanel(current, panel.id, config)),
                      onRemove: () => onLayoutChange((current) => removePanel(current, panel.id)),
                      placement: {
                        onMove: (direction) =>
                          onLayoutChange((current) => movePanel(current, panel.id, direction)),
                        onResize: (size) =>
                          onLayoutChange((current) => resizePanel(current, panel.id, size)),
                      },
                    }
                  : {})}
              />
            </div>
          ))}
        </div>
      )}
      {isAdding && onLayoutChange && (
        <ChartPanelEditor
          dialogTitle={text.addChart}
          initial={{
            panel: createPanelConfig(metricKeys.slice(0, 1)),
            view: { xScale: 'linear', showRaw: true },
          }}
          metricKeys={metricKeys}
          {...(grouping ? { grouping } : {})}
          onClose={() => setIsAdding(false)}
          onSave={({ panel }) => {
            setIsAdding(false);
            onLayoutChange((current) => addPanel(current, panel, { id: createPanelId() }));
          }}
        />
      )}
    </section>
  );
}
