import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Play, RefreshCw, Upload } from 'lucide-react';
import type { Run } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { Resource } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { MetricsChart } from '../components/MetricsChart';
import { Tabs } from '../components/Tabs';
import { RunLogs } from '../components/RunLogs';
import { RunArtifacts } from '../components/RunArtifacts';
import { RunExecutionSnapshot } from '../components/RunExecutionSnapshot';
import { RunOutputModels } from '../components/RunOutputModels';
import { RunCheckpointList } from '../components/RunCheckpointList';
import { DetailsList, KeyValues } from '../components/JsonDetails';
import { FormDialog } from '../components/FormDialog';
import { ArtifactUploadDialog } from '../dialogs/ArtifactUploadDialog';
import { LaunchDialog } from '../dialogs/LaunchDialog';
import { getFieldValue, parseStringMap } from '../lib/formValues';
import { formatDate, formatDuration } from '../lib/format';
import { isSystemMetric } from '../lib/metricSeries';
import { getRunParameters } from '../lib/runParameters';
import { getResumeCheckpointRecord } from '../lib/checkpointResume';
import { text, textTemplates } from '../i18n/catalog';

const tabs = [
  'metrics',
  'artifacts',
  'checkpoints',
  'systemMetrics',
  'logs',
  'details',
  'executionSnapshot',
] as const;
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
  const metrics = useQuery(
    tab === 'metrics' || tab === 'systemMetrics' ? `${runId}:metrics` : null,
    (signal) => trackingApi.metrics(project.id, runId, signal),
    EXECUTION_POLL_MS,
  );
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
    metrics.reload();
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
                  <StatusBadge status={item.status} />
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
            <Tabs
              tabs={tabs.map((key) => ({ key, label: text[key] }))}
              selected={tab}
              onSelect={(key) => setParams({ tab: key })}
            />
            <div
              id="run-tab-panel"
              role="tabpanel"
              aria-label={text[tabs.find((key) => key === tab) ?? 'metrics']}
              className="detail-content"
            >
              {(tab === 'metrics' || tab === 'systemMetrics') && (
                <Resource query={metrics}>
                  {(points) => (
                    <MetricsChart
                      series={[
                        {
                          id: item.id,
                          label: item.name,
                          points: points.filter((point) =>
                            tab === 'systemMetrics'
                              ? isSystemMetric(point.name)
                              : !isSystemMetric(point.name),
                          ),
                        },
                      ]}
                    />
                  )}
                </Resource>
              )}
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
                  <section>
                    <h2>{text.details}</h2>
                    <DetailsList
                      entries={[
                        [text.created, formatDate(item.createdAt)],
                        [text.user, item.createdBy],
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
                  <section>
                    <h2>{text.parameters}</h2>
                    <KeyValues values={getRunParameters(item)} />
                  </section>
                  <section>
                    <h2>{text.tags}</h2>
                    <KeyValues values={item.tags} />
                  </section>
                  <section>
                    <h2>{text.environment}</h2>
                    <KeyValues values={item.environment} />
                  </section>
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
