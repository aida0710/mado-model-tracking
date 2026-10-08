import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Play, RefreshCw, Upload } from 'lucide-react';
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
import { DetailsList, KeyValues } from '../components/JsonDetails';
import { FormDialog } from '../components/FormDialog';
import { ArtifactUploadDialog } from '../dialogs/ArtifactUploadDialog';
import { LaunchDialog } from '../dialogs/LaunchDialog';
import { getFieldValue, parseStringMap } from '../lib/formValues';
import { formatDate, formatDuration } from '../lib/format';
import { isSystemMetric } from '../lib/metricSeries';
import { getRunParameters } from '../lib/runParameters';
import { text } from '../i18n/catalog';

const tabs = ['metrics', 'artifacts', 'systemMetrics', 'logs', 'details'] as const;
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
  const artifacts = useQuery(
    tab === 'artifacts' ? `${runId}:artifacts` : null,
    (signal) => trackingApi.artifacts(project.id, runId, signal),
    EXECUTION_POLL_MS,
  );
  function reload() {
    run.reload();
    metrics.reload();
    logs.reload();
    artifacts.reload();
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
                  <span>{formatDuration(item.startedAt, item.endedAt)}</span>
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
                  <Resource query={artifacts}>
                    {(files) => <RunArtifacts artifacts={files} />}
                  </Resource>
                </>
              )}
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
            {dialog === 'upload' && (
              <ArtifactUploadDialog
                projectId={project.id}
                runId={runId}
                onClose={() => setDialog(null)}
                onSaved={() => {
                  setDialog(null);
                  artifacts.reload();
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
    </section>
  );
}
