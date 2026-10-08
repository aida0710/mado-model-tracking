import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Play, RefreshCw } from 'lucide-react';
import { executionApi } from '../api/execution';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { Resource } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { DetailsList } from '../components/JsonDetails';
import { RunLogs } from '../components/RunLogs';
import { RunExecutionSnapshot } from '../components/RunExecutionSnapshot';
import { FormDialog } from '../components/FormDialog';
import { LaunchDialog } from '../dialogs/LaunchDialog';
import { formatDate } from '../lib/format';
import { isJobUnresponsive } from '../lib/jobLiveness';
import { text } from '../i18n/catalog';

const activeStatuses = ['queued', 'claimed', 'running'];
export function JobsPage() {
  const { project, canEdit } = useProject();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('job') ?? '';
  const statusFilter = params.get('status') ?? '';
  const [showLaunch, setShowLaunch] = useState(false);
  const [jobAction, setJobAction] = useState<{ id: string; type: 'cancel' | 'retry' } | null>(null);
  const jobs = useQuery(
    `${project.id}:jobs`,
    (signal) => executionApi.jobs(project.id, signal),
    EXECUTION_POLL_MS,
  );
  const targets = useQuery('job-targets', executionApi.targets);
  const selected = jobs.value?.find((job) => job.id === selectedId);
  const selectedRun = useQuery(selected ? `${project.id}:job-run:${selected.runId}` : null,
    (signal) => trackingApi.run(project.id, selected!.runId, signal), EXECUTION_POLL_MS);
  const sourceArtifacts = useQuery(selected ? `${project.id}:job-artifacts:${selected.runId}` : null,
    (signal) => trackingApi.artifacts(project.id, selected!.runId, signal), EXECUTION_POLL_MS);
  const logs = useQuery(
    selected ? `${selected.runId}:logs` : null,
    (signal) => trackingApi.logs(project.id, selected!.runId, signal),
    EXECUTION_POLL_MS,
  );
  return (
    <section className="page">
      <PageHeader
        title={text.jobs}
        eyebrow={project.name}
        actions={
          <>
            {canEdit && (
              <button className="button primary" onClick={() => setShowLaunch(true)}>
                <Play size={15} />
                {text.launch}
              </button>
            )}
            <button className="icon-button" aria-label={text.refresh} onClick={jobs.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <label className="chart-selector">
        <span>{text.status}</span>
        <select
          aria-label={text.status}
          value={statusFilter}
          onChange={(event) =>
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.set('status', event.target.value);
              return next;
            })
          }
        >
          <option value="">{text.allStatus}</option>
          {(['queued', 'claimed', 'running', 'finished', 'failed', 'canceled'] as const).map(
            (status) => (
              <option key={status} value={status}>
                {text[status]}
              </option>
            ),
          )}
        </select>
      </label>
      <Resource query={jobs}>
        {(items) => (
          <DataTable
            items={items.filter((job) => !statusFilter || job.status === statusFilter)}
            rowKey={(job) => job.id}
            selectedKey={selectedId}
            columns={[
              {
                key: 'id',
                label: text.jobs,
                render: (job) => (
                  <button
                    className="link-button mono"
                    onClick={() =>
                      setParams((previous) => {
                        const next = new URLSearchParams(previous);
                        next.set('job', job.id);
                        return next;
                      })
                    }
                  >
                    {job.id}
                  </button>
                ),
              },
              {
                key: 'status',
                label: text.status,
                render: (job) => (
                  <>
                    <StatusBadge status={job.status} />
                    {isJobUnresponsive(job) && (
                      // The red Job status color marks a silent worker; the Job status itself is unchanged.
                      <span className="status-badge status-failed" title={text.jobUnresponsiveHint}>
                        {text.jobUnresponsive}
                      </span>
                    )}
                    {job.cancelRequested && <small>{text.cancelRequested}</small>}
                  </>
                ),
              },
              {
                key: 'run',
                label: text.runs,
                render: (job) => (
                  <Link className="mono" to={`/projects/${project.id}/runs/${job.runId}`}>
                    {job.runId}
                  </Link>
                ),
              },
              {
                key: 'target',
                label: text.target,
                render: (job) =>
                  targets.value?.find((target) => target.id === job.targetId)?.name ?? job.targetId,
              },
              {
                key: 'gpu',
                label: text.gpuIds,
                className: 'mono',
                render: (job) => job.gpuIds.join(', ') || text.cpuOnly,
              },
              {
                key: 'attempt',
                label: text.attempt,
                className: 'mono',
                render: (job) => `${job.attempt} / ${job.maxAttempts}`,
              },
              { key: 'created', label: text.created, render: (job) => formatDate(job.createdAt) },
              {
                key: 'actions',
                label: text.details,
                render: (job) =>
                  canEdit &&
                  (activeStatuses.includes(job.status) ? (
                    <button
                      className="button small"
                      disabled={job.cancelRequested}
                      onClick={() => setJobAction({ id: job.id, type: 'cancel' })}
                    >
                      {text.cancelJob}
                    </button>
                  ) : (
                    <button
                      className="button small"
                      onClick={() => setJobAction({ id: job.id, type: 'retry' })}
                    >
                      {text.retryJob}
                    </button>
                  )),
              },
            ]}
          />
        )}
      </Resource>
      {selected && (
        <section className="job-detail">
          <h2 className="mono">{selected.id}</h2>
          <DetailsList
            entries={[
              [text.heartbeat, formatDate(selected.heartbeatAt)],
              [text.exitCode, selected.exitCode],
              [text.jobError, selected.error],
            ]}
          />
          <Resource query={selectedRun}>
            {(run) => (
              <Resource query={sourceArtifacts}>
                {(artifacts) => <RunExecutionSnapshot run={run} artifacts={artifacts} />}
              </Resource>
            )}
          </Resource>
          <h3>{text.logs}</h3>
          <Resource query={logs}>{(entries) => <RunLogs entries={entries} />}</Resource>
        </section>
      )}
      {showLaunch && (
        <LaunchDialog
          onClose={() => setShowLaunch(false)}
          onSaved={(job) => {
            setShowLaunch(false);
            jobs.reload();
            setParams({ job: job.id });
          }}
        />
      )}
      {jobAction && (
        <FormDialog
          title={jobAction.type === 'cancel' ? text.cancelJob : text.retryJob}
          onClose={() => setJobAction(null)}
          fields={[]}
          onSubmit={async () =>
            jobAction.type === 'cancel'
              ? { canceled: await executionApi.cancelJob(project.id, jobAction.id) }
              : executionApi.retryJob(project.id, jobAction.id)
          }
          onSaved={(saved) => {
            setJobAction(null);
            jobs.reload();
            if ('run' in saved) navigate(`/projects/${project.id}/runs/${saved.run.id}`);
          }}
        />
      )}
    </section>
  );
}
