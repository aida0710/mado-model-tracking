import { Component, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pin, Radio } from 'lucide-react';
import type { MediaTablePage, ReportBlock, ReportBlockSnapshot, ReportEmbedBlock, ReportSnapshotData } from '@mmt/contracts';
import { MarkdownView } from '../markdown/MarkdownView';
import { MetricsChart } from '../charts/MetricsChart';
import { ParallelCoordinatesChart } from '../analysis/ParallelCoordinatesChart';
import { ParameterImportanceTable } from '../analysis/ParameterImportanceTable';
import { ParamScatterChart } from '../analysis/ParamScatterChart';
import { MediaCompareGrid } from '../media/MediaCompareGrid';
import { MediaTableView } from '../media/MediaTableView';
import { MediaCell } from '../media/MediaCell';
import { RunTable } from '../runs/RunTable';
import { Empty, ErrorNotice, Loading } from '../Feedback';
import { useLiveBlockData } from '../../hooks/useReportBlockData';
import { useExclusiveAudio } from '../../hooks/useExclusiveAudio';
import { CHART_ROW_HEIGHT_PX } from '../charts/ChartPanel';
import { formatSnapshotTime, reportChartSeries, snapshotRunLabels } from '../../lib/reportBlocks';
import { analysisRows, metricFieldKey, metricFields, paramFieldKey, paramFields } from '../../lib/runAnalysisFields';
import { reportBlockTypeLabels } from '../../i18n/reports';
import { text, textTemplates } from '../../i18n/catalog';

// Chart and analysis heights inside a report, which is narrower than the Run list's chart grid.
const REPORT_CHART_HEIGHT_PX = 2 * CHART_ROW_HEIGHT_PX;
const REPORT_ANALYSIS_HEIGHT_PX = 360;
// Run list column keys that are not metrics or params (components/runs/RunTable).
const RUN_NAME_COLUMN = 'name';

/**
 * Where an embed's data comes from. `preview` is the editor's: a snapshot block whose stored data
 * is missing or outdated draws the current data until it is saved.
 */
export interface ReportBlockViewProps {
  projectId: string;
  block: ReportBlock;
  snapshot: ReportBlockSnapshot | undefined;
  /** The snapshot query failed or is still loading; only snapshot blocks wait for it. */
  snapshotState?: { loading: boolean; error: string | null; reload: () => void };
  preview?: boolean;
}

/** One block of a report: Markdown, or an embed drawn by the same components as the other pages. */
export function ReportBlockView({ projectId, block, snapshot, snapshotState, preview = false }: ReportBlockViewProps) {
  if (block.type === 'markdown')
    return (
      <div className="report-markdown">
        <MarkdownView source={block.text} />
      </div>
    );
  const drawsSnapshot = block.mode === 'snapshot' && (snapshot !== undefined || !preview);
  return (
    <figure className="report-embed" data-block-type={block.type}>
      <figcaption className="report-embed-header">
        <span className="report-embed-type">{reportBlockTypeLabels[block.type]}</span>
        <EmbedModeMark block={block} snapshot={drawsSnapshot ? snapshot : undefined} />
      </figcaption>
      <BlockErrorBoundary key={JSON.stringify(block)}>
        {drawsSnapshot ? (
          snapshot ? (
            <EmbedContent projectId={projectId} block={block} data={snapshot.data} />
          ) : snapshotState?.error ? (
            <ErrorNotice message={snapshotState.error} retry={snapshotState.reload} />
          ) : snapshotState?.loading ? (
            <Loading />
          ) : (
            <Empty>{text.reportSnapshotMissing}</Empty>
          )
        ) : block.type === 'media_table' ? (
          <MediaTableView projectId={projectId} runId={block.runId} mediaId={block.mediaId} />
        ) : (
          <LiveEmbed projectId={projectId} block={block} />
        )}
      </BlockErrorBoundary>
    </figure>
  );
}

function EmbedModeMark({ block, snapshot }: { block: ReportEmbedBlock; snapshot: ReportBlockSnapshot | undefined }) {
  if (block.mode === 'live')
    return (
      <span className="report-mode-mark live">
        <Radio size={13} />
        {text.reportModeLive}
      </span>
    );
  return (
    <span className="report-mode-mark snapshot" data-testid="report-snapshot-mark">
      <Pin size={13} />
      {snapshot ? textTemplates.reportSnapshotAt(formatSnapshotTime(snapshot.capturedAt)) : text.reportSnapshotPending}
    </span>
  );
}

function LiveEmbed({ projectId, block }: { projectId: string; block: Exclude<ReportEmbedBlock, { type: 'media_table' }> }) {
  const data = useLiveBlockData(projectId, block);
  if (data.error)
    return (
      <div className="report-embed-error">
        <strong>{text.reportEmbedError}</strong>
        <ErrorNotice message={data.error} retry={data.reload} />
      </div>
    );
  if (!data.value) return <Loading />;
  return <EmbedContent projectId={projectId} block={block} data={data.value} />;
}

/** Draws stored or current data. Data of another type (a block edited since) is not drawn. */
function EmbedContent({ projectId, block, data }: { projectId: string; block: ReportEmbedBlock; data: ReportSnapshotData }) {
  const navigate = useNavigate();
  const runPath = (runId: string) => `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;
  if (block.type !== data.type) return <Empty>{text.reportSnapshotMissing}</Empty>;
  switch (data.type) {
    case 'chart': {
      if (block.type !== 'chart') return null;
      const { panel } = block;
      return (
        <div className="report-chart">
          {panel.title && <h3>{panel.title}</h3>}
          <MetricsChart
            series={reportChartSeries(data, panel.metricKeys)}
            xAxis={panel.xAxis}
            yScale={panel.yScale}
            smoothing={panel.smoothing}
            showRange={panel.showRange}
            showRaw={panel.smoothing.kind !== 'none'}
            height={REPORT_CHART_HEIGHT_PX}
          />
        </div>
      );
    }
    case 'parallel_coordinates': {
      if (block.type !== 'parallel_coordinates') return null;
      const params = paramFields(data.table);
      const metricKey = metricFieldKey(block.metric);
      const axes = [
        ...(block.params ?? []).flatMap((param) => params.find((field) => field.key === paramFieldKey(param)) ?? []),
        ...metricFields(data.table, text.analysisSweepObjective).filter((field) => field.key === metricKey),
      ];
      return (
        <ParallelCoordinatesChart
          rows={analysisRows(data.table)}
          axes={axes}
          colorAxisKey={metricKey}
          height={REPORT_ANALYSIS_HEIGHT_PX}
        />
      );
    }
    case 'parameter_importance':
      return <ParameterImportanceTable result={data.importance} />;
    case 'scatter': {
      if (block.type !== 'scatter') return null;
      return (
        <ParamScatterChart
          rows={analysisRows(data.table)}
          fields={[...paramFields(data.table), ...metricFields(data.table, text.analysisSweepObjective)]}
          defaultX={block.x}
          defaultY={block.y}
          defaultColor={block.color}
          onRunClick={(runId) => navigate(runPath(runId))}
          height={REPORT_ANALYSIS_HEIGHT_PX}
        />
      );
    }
    case 'run_table': {
      if (block.type !== 'run_table') return null;
      const columnNames = (prefix: string) =>
        block.columns.filter((column) => column.startsWith(prefix)).map((column) => column.slice(prefix.length));
      return (
        <RunTable
          projectId={projectId}
          runs={data.runs}
          metricNames={columnNames('metrics.')}
          parameterNames={columnNames('params.')}
          isColumnVisible={(column) => column === RUN_NAME_COLUMN || block.columns.includes(column)}
          selectedIds={[]}
          onSelectedIdsChange={() => undefined}
        />
      );
    }
    case 'media':
      return <MediaCompareGrid projectId={projectId} grid={data.grid} runLabels={snapshotRunLabels(data.runs)} />;
    case 'media_table':
      return <SnapshotMediaTable projectId={projectId} page={data.page} />;
  }
}

/** The first page of a table as it was stored; the cells still point at immutable Artifacts. */
function SnapshotMediaTable({ projectId, page }: { projectId: string; page: MediaTablePage }) {
  const exclusiveAudio = useExclusiveAudio();
  return (
    <div className="media-table">
      <div className="media-table-toolbar">
        <span>{textTemplates.mediaTableRowCount(page.totalRows)}</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="mono">#</th>
              {page.columns.map((column) => (
                <th key={column.name}>{column.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td className="mono muted">{page.offset + rowIndex + 1}</td>
                {page.columns.map((column, columnIndex) => (
                  <td key={column.name}>
                    <MediaCell
                      projectId={projectId}
                      column={column}
                      value={row[columnIndex]}
                      playback={{ exclusiveAudio, cellId: `${rowIndex}:${columnIndex}` }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Keeps a failing embed from taking down the rest of the report. */
class BlockErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <ErrorNotice message={text.reportEmbedRenderError} />;
    return this.props.children;
  }
}
