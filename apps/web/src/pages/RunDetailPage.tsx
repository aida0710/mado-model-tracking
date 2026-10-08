import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Play, RefreshCw, Upload } from 'lucide-react';
import {
  RUN_NOTE_TAG,
  type ChartPanelLayout,
  type ChartXAxis,
  type Run,
  type RunResumeEventPage,
} from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { Resource } from '../components/Feedback';
import { RunStatusBadge } from '../components/runs/RunStatusBadge';
import { ChartPanelGrid } from '../components/charts/ChartPanelGrid';
import { RunResumeTimeline } from '../components/RunResumeTimeline';
import { RunDescriptionEditor } from '../components/RunDescriptionEditor';
import { CommentThread } from '../components/comments/CommentThread';
import { RunMediaPanel } from '../components/media/RunMediaPanel';
import { Tabs } from '../components/Tabs';
import { RunLogs } from '../components/RunLogs';
import { RunArtifacts } from '../components/RunArtifacts';
import { RunExecutionSnapshot } from '../components/RunExecutionSnapshot';
import { RunOutputModels } from '../components/RunOutputModels';
import { RunCheckpointList } from '../components/RunCheckpointList';
import { RunDownstream } from '../components/RunDownstream';
import { DetailsList, KeyValues } from '../components/JsonDetails';
import { FormDialog } from '../components/FormDialog';
import { ArtifactUploadDialog } from '../dialogs/ArtifactUploadDialog';
import { LaunchDialog } from '../dialogs/LaunchDialog';
import { getFieldValue, parseStringMap } from '../lib/formValues';
import { formatDate, formatDuration } from '../lib/format';
import { resumeMarkers } from '../lib/metricSeries';
import {
  addPanel,
  createDefaultLayout,
  createPanelConfig,
  emptyChartPanelLayout,
  MAX_PANEL_METRIC_KEYS,
} from '../lib/chartPanelLayout';
import {
  groupSystemMetricKeys,
  isSystemMetricKey,
  systemMetricValueScale,
} from '../lib/systemMetricKeys';
import { getRunChartKeys } from '../lib/runChartKeys';
import { useChartPanelLayout } from '../hooks/useChartPanelLayout';
import { useRunResumeEvents } from '../hooks/useRunResumeEvents';
import { getRunParameters } from '../lib/runParameters';
import { creatorName } from '../lib/creatorName';
import { getResumeCheckpointRecord } from '../lib/checkpointResume';
import { text, textTemplates } from '../i18n/catalog';
import { systemMetricCategoryLabels, systemMetricUnitLabels } from '../i18n/runs';

const tabs = [
  'metrics',
  'media',
  'artifacts',
  'checkpoints',
  'systemMetrics',
  'logs',
  'details',
  'executionSnapshot',
] as const;
type RunTab = (typeof tabs)[number];
const tabLabels: Record<RunTab, string> = {
  metrics: text.metrics,
  media: text.mediaTab,
  artifacts: text.artifacts,
  checkpoints: text.checkpoints,
  systemMetrics: text.systemMetrics,
  logs: text.logs,
  details: text.details,
  executionSnapshot: text.executionSnapshot,
};

export function RunDetailPage() {
  const { project, canEdit } = useProject();
  const { runId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab');
  const tab = tabs.find((key) => key === requestedTab) ?? 'metrics';
  const [dialog, setDialog] = useState<'edit' | 'upload' | 'launch' | null>(null);
  const run = useQuery(
    `${project.id}:run:${runId}`,
    (signal) => trackingApi.run(project.id, runId, signal),
    EXECUTION_POLL_MS,
  );
  const resumeEvents = useRunResumeEvents(project.id, runId, run.value?.status);
  const logs = useQuery(
    tab === 'logs' ? `${runId}:logs` : null,
    (signal) => trackingApi.logs(project.id, runId, signal),
    EXECUTION_POLL_MS,
  );
  // The artifacts tab pages by folder itself; only the execution snapshot needs every file.
  const [artifactRevision, setArtifactRevision] = useState(0);
  const artifacts = useQuery(
    tab === 'executionSnapshot' ? `${runId}:artifacts` : null,
    (signal) => trackingApi.artifacts(project.id, runId, signal),
    EXECUTION_POLL_MS,
  );
  function reload() {
    run.reload();
    resumeEvents.reload();
    logs.reload();
    artifacts.reload();
    setArtifactRevision((value) => value + 1);
  }
  const base = `/projects/${project.id}`;
  return (
    <section className="page">
      <Resource query={run}>
        {(item) => (
          <>
            <PageHeader
              title={item.name}
              eyebrow={
                <>
                  <Link to={`${base}/experiments?experiment=${item.experimentId}`}>
                    {text.experiments}
                  </Link>
                  <span className="breadcrumb-separator">/</span>
                  {text.runs}
                </>
              }
              description={
                <>
                  <RunStatusBadge run={item} />
                  <span className="mono">{item.id}</span>
                  <span>{text[item.kind]}</span>
                  <span>{item.executionMode === 'test' ? text.testMode : text.runMode}</span>
                  {item.taskId && <Link to={`${base}/tasks?id=${item.taskId}`}>{text.taskRevision}: {item.taskRevision}</Link>}
                  <span>{formatDuration(item.startedAt, item.endedAt)}</span>
                  <ResumedFromCheckpoint run={item} />
                </>
              }
              actions={
                <>
                  {canEdit && (
                    <>
                      <button className="button" onClick={() => setDialog('edit')}>
                        {text.editRun}
                      </button>
                      {item.status === 'queued' && item.codeVersionId && (
                        <button className="button primary" onClick={() => setDialog('launch')}>
                          <Play size={15} />
                          {text.launch}
                        </button>
                      )}
                    </>
                  )}
                  <button className="icon-button" onClick={reload} aria-label={text.refresh}>
                    <RefreshCw size={17} />
                  </button>
                </>
              }
            />
            {item.error && (
              <div className="notice error" role="alert">
                {item.error}
              </div>
            )}
            {resumeEvents.value && (
              <RunResumeTimeline segments={resumeEvents.value.segments} now={Date.now()} />
            )}
            <Tabs
              tabs={tabs.map((key) => ({ key, label: tabLabels[key] }))}
              selected={tab}
              onSelect={(key) => setParams({ tab: key })}
            />
            <div
              id="run-tab-panel"
              role="tabpanel"
              aria-label={tabLabels[tab]}
              className="detail-content"
            >
              {tab === 'metrics' && (
                <RunMetricCharts run={item} resumeEvents={resumeEvents.value} />
              )}
              {tab === 'systemMetrics' && <RunSystemMetricCharts key={item.id} run={item} />}
              {tab === 'media' && <RunMediaPanel projectId={project.id} runId={runId} />}
              {tab === 'logs' && (
                <Resource query={logs}>{(entries) => <RunLogs entries={entries} />}</Resource>
              )}
              {tab === 'executionSnapshot' && <Resource query={artifacts}>
                {(files) => <RunExecutionSnapshot run={item} artifacts={files} />}
              </Resource>}
              {tab === 'artifacts' && (
                <>
                  {canEdit && (
                    <div className="section-actions">
                      <button className="button" onClick={() => setDialog('upload')}>
                        <Upload size={15} />
                        {text.uploadArtifact}
                      </button>
                    </div>
                  )}
                  <RunArtifacts projectId={project.id} runId={runId} revision={artifactRevision} />
                </>
              )}
              {tab === 'checkpoints' && <RunCheckpointList run={item} canEdit={canEdit} />}
              {tab === 'details' && (
                <div className="details-grid">
                  <RunDescriptionEditor projectId={project.id} run={item} />
                  <section>
                    <h2>{text.details}</h2>
                    <DetailsList
                      entries={[
                        [text.created, formatDate(item.createdAt)],
                        [text.user, <span title={item.createdBy}>{creatorName(item)}</span>],
                        [
                          text.modelVersion,
                          item.modelVersionId ? (
                            <Link
                              className="mono"
                              to={`${base}/models?version=${item.modelVersionId}`}
                            >
                              {item.modelVersionId}
                            </Link>
                          ) : null,
                        ],
                        [
                          text.codeVersion,
                          item.codeVersionId ? (
                            <Link
                              className="mono"
                              to={`${base}/codes?version=${item.codeVersionId}`}
                            >
                              {item.codeVersionId}
                            </Link>
                          ) : null,
                        ],
                        [
                          text.parentRun,
                          item.parentRunId ? (
                            <Link to={`${base}/runs/${item.parentRunId}`}>{item.parentRunId}</Link>
                          ) : null,
                        ],
                        [
                          text.inputDatasets,
                          item.inputDatasetVersionIds.map((id) => (
                            <Link
                              className="version-link mono"
                              key={id}
                              to={`${base}/datasets?version=${id}`}
                            >
                              {id}
                            </Link>
                          )),
                        ],
                        [text.outputModels, <RunOutputModels run={item} />],
                        [
                          text.outputDatasets,
                          item.outputDatasetVersionIds.map((id) => (
                            <Link
                              className="version-link mono"
                              key={id}
                              to={`${base}/datasets?version=${id}`}
                            >
                              {id}
                            </Link>
                          )),
                        ],
                      ]}
                    />
                  </section>
                  <RunDownstream projectId={project.id} runId={runId} />
                  <section>
                    <h2>{text.parameters}</h2>
                    <KeyValues values={getRunParameters(item)} />
                  </section>
                  <section>
                    <h2>{text.tags}</h2>
                    <KeyValues values={tagsWithoutDescription(item.tags)} />
                  </section>
                  <section>
                    <h2>{text.environment}</h2>
                    <KeyValues values={item.environment} />
                  </section>
                  <CommentThread projectId={project.id} targetType="run" targetId={runId} />
                </div>
              )}
            </div>
            {dialog === 'edit' && (
              <FormDialog
                title={text.editRun}
                onClose={() => setDialog(null)}
                fields={[
                  { name: 'name', label: text.name, required: true, defaultValue: item.name },
                  {
                    name: 'tags',
                    label: `${text.tags} (JSON)`,
                    type: 'textarea',
                    defaultValue: JSON.stringify(item.tags, null, 2),
                  },
                ]}
                onSubmit={(values) =>
                  trackingApi.updateRun(project.id, runId, {
                    name: getFieldValue(values, 'name'),
                    tags: parseStringMap(getFieldValue(values, 'tags')),
                  })
                }
                onSaved={() => {
                  setDialog(null);
                  run.reload();
                }}
              />
            )}
            {dialog === 'launch' && (
              <LaunchDialog
                existingRun={item}
                onClose={() => setDialog(null)}
                onSaved={() => {
                  setDialog(null);
                  reload();
                }}
              />
            )}
          </>
        )}
      </Resource>
      {/* Outside Resource: a failed Run poll must not unmount the dialog and stop its uploads. */}
      {dialog === 'upload' && (
        <ArtifactUploadDialog
          projectId={project.id}
          runId={runId}
          multiple
          onClose={() => setDialog(null)}
          onSaved={() => {
            artifacts.reload();
            setArtifactRevision((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}

/** For a Run that continues from a checkpoint: the step it starts from and the Run that saved it. */
function ResumedFromCheckpoint({ run }: { run: Run }) {
  const resume = getResumeCheckpointRecord(run);
  if (!resume) return null;
  return (
    <>
      <span>{textTemplates.checkpointResumedFromStep(resume.step)}</span>
      <Link to={`/projects/${run.projectId}/runs/${resume.sourceRunId}?tab=checkpoints`}>
        {text.checkpointSourceRun}
      </Link>
    </>
  );
}

const runLabelsOf = (run: Run) => ({ [run.id]: run.name });

// The description is shown above as Markdown; as a tag it would repeat it as one raw line.
function tagsWithoutDescription(tags: Record<string, string>): Record<string, string> {
  const { [RUN_NOTE_TAG]: _description, ...rest } = tags;
  return rest;
}

/**
 * System metrics are sampled by the worker on a timer, so their step is a sample number, not the
 * training step; elapsed time lines them up with the Run instead.
 */
const SYSTEM_METRIC_X_AXIS: ChartXAxis = { kind: 'relative_time' };

/** Metric panels of one Run, arranged per Project; resumed segments are marked on the x axis. */
function RunMetricCharts({
  run,
  resumeEvents,
}: {
  run: Run;
  resumeEvents: RunResumeEventPage | undefined;
}) {
  const metricKeys = useMemo(() => getRunChartKeys([run]).metricKeys, [run]);
  const defaultLayout = useMemo(
    () => createDefaultLayout(metricKeys, (index) => `default-${index}`),
    [metricKeys],
  );
  const { layout, isCustomized, updateLayout, resetLayout } = useChartPanelLayout(
    run.projectId,
    'runDetail',
    defaultLayout,
  );
  const markersFor = (xAxis: ChartXAxis) =>
    resumeEvents ? resumeMarkers(xAxis, [{ label: text.chartResumeMarker, resumeEvents }]) : [];
  return (
    <ChartPanelGrid
      projectId={run.projectId}
      layout={layout}
      source={{ runIds: [run.id] }}
      runLabels={runLabelsOf(run)}
      live={run.status === 'running'}
      metricKeys={metricKeys}
      markersFor={markersFor}
      onLayoutChange={updateLayout}
      {...(isCustomized ? { onResetLayout: resetLayout } : {})}
    />
  );
}

/**
 * One panel per category, GPU and unit, the same for worker/SDK and MLflow names. The panels
 * follow the Run's metrics; changes last while the tab is open.
 */
function RunSystemMetricCharts({ run }: { run: Run }) {
  const metricKeys = useMemo(
    () => Object.keys(run.latestMetrics).filter(isSystemMetricKey).sort(),
    [run.latestMetrics],
  );
  const defaultLayout = useMemo(() => createSystemMetricLayout(metricKeys), [metricKeys]);
  const [changedLayout, setChangedLayout] = useState<ChartPanelLayout | null>(null);
  const layout = changedLayout ?? defaultLayout;
  return (
    <ChartPanelGrid
      projectId={run.projectId}
      layout={layout}
      source={{ runIds: [run.id] }}
      runLabels={runLabelsOf(run)}
      live={run.status === 'running'}
      metricKeys={metricKeys}
      valueScale={systemMetricValueScale}
      onLayoutChange={(change) => setChangedLayout(change(layout))}
      {...(changedLayout ? { onResetLayout: () => setChangedLayout(null) } : {})}
      emptyMessage={text.systemMetricsEmpty}
    />
  );
}

function createSystemMetricLayout(metricKeys: string[]): ChartPanelLayout {
  return groupSystemMetricKeys(metricKeys).reduce((layout, group) => {
    const title = textTemplates.systemMetricPanelTitle(
      systemMetricCategoryLabels[group.category],
      systemMetricUnitLabels[group.unit],
      group.gpuIndex,
    );
    const panel = {
      ...createPanelConfig(group.metricKeys.slice(0, MAX_PANEL_METRIC_KEYS), title),
      xAxis: SYSTEM_METRIC_X_AXIS,
    };
    return addPanel(layout, panel, { id: `system-${group.id}`, width: 'half' });
  }, emptyChartPanelLayout());
}
