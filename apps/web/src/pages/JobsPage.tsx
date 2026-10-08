import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Play, RefreshCw } from 'lucide-react';
import { executionApi } from '../api/execution';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { Resource } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';
import { DetailsList } from '../components/JsonDetails';
import { RunLogs } from '../components/RunLogs';
import { RunExecutionSnapshot } from '../components/RunExecutionSnapshot';
import { FormDialog } from '../components/FormDialog';
import { LaunchDialog } from '../dialogs/LaunchDialog';
import { ResumeDialog } from '../dialogs/ResumeDialog';
import { useResumedRunIds } from '../hooks/useResumedRunIds';
import { isResumableStatus } from '../lib/checkpointResume';
import { formatDate } from '../lib/format';
import { isJobUnresponsive } from '../lib/jobLiveness';
import { text } from '../i18n/catalog';

const activeStatuses = ['queued', 'claimed', 'running'];
// The full id stays in the title; eight characters tell Jobs apart in one Project.
const SHORT_ID_LENGTH = 8;
const shortId = (id: string) => id.slice(0, SHORT_ID_LENGTH);
export function JobsPage() {
  const { project, canEdit } = useProject();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('job') ?? '';
  const statusFilter = params.get('status') ?? '';
  const [showLaunch, setShowLaunch] = useState(false);
  const [jobAction, setJobAction] = useState<{
    id: string;
    type: 'cancel' | 'retry' | 'resumeLatest';
  } | null>(null);
  const jobs = useQuery(
    `${project.id}:jobs`,
    (signal) => executionApi.jobs(project.id, signal),
    EXECUTION_POLL_MS,
  );
  const targets = useQuery('job-targets', executionApi.targets);
  const resumedRunIds = useResumedRunIds(project.id, jobs.value);
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
    <section className="page jobs-page">
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
          <ResponsiveTable
            rows={items.filter((job) => !statusFilter || job.status === statusFilter)}
            rowKey={(job) => job.id}
            selectedKey={selectedId}
            columns={[
              {
                key: 'id',
                priority: 'primary',
                header: text.jobColumn,
                render: (job) => (
                  <button
                    className="link-button mono"
                    title={job.id}
                    onClick={() =>
                      setParams((previous) => {
                        const next = new URLSearchParams(previous);
                        next.set('job', job.id);
                        return next;
                      })
                    }
                  >
                    {shortId(job.id)}
                  </button>
                ),
              },
              {
                key: 'status',
                priority: 'primary',
                header: text.status,
                render: (job) => (
                  <>
                    <StatusBadge status={job.status} earlyStopped={job.sweepEarlyStopped} />
                    {isJobUnresponsive(job) && (
                      // The red Job status color marks a silent worker; the Job status itself is unchanged.
                      <span className="status-badge status-failed" title={text.jobUnresponsiveHint}>
                        {text.jobUnresponsive}
                      </span>
                    )}
                    {job.cancelRequested && !job.sweepEarlyStopped && (
                      <small>{text.cancelRequested}</small>
                    )}
                  </>
                ),
              },
              {
                key: 'run',
                priority: 'primary',
                header: text.jobRunColumn,
                className: 'job-run-cell',
                render: (job) => (
                  <>
                    <Link to={`/projects/${project.id}/runs/${job.runId}`} title={job.runId}>
                      {job.runName}
                    </Link>
                    <small className="muted"> {text[job.runKind]}</small>
                    {resumedRunIds.value?.has(job.runId) && (
                      <span
                        className="status-badge status-running resumed-run-badge"
                        title={text.checkpointResumedBadgeHint}
                      >
                        {text.checkpointResumedBadge}
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'task',
                priority: 'secondary',
                header: text.task,
                render: (job) =>
                  job.taskId ? (
                    <Link to={`/projects/${project.id}/tasks?id=${job.taskId}`}>
                      {job.taskName ?? shortId(job.taskId)}
                    </Link>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'target',
                priority: 'secondary',
                header: text.target,
                render: (job) =>
                  targets.value?.find((target) => target.id === job.targetId)?.name ?? job.targetId,
              },
              {
                key: 'gpu',
                priority: 'secondary',
                header: text.gpuIds,
                className: 'mono nowrap',
                render: (job) => job.gpuIds.join(', ') || text.cpuOnly,
              },
              {
                key: 'attempt',
                priority: 'secondary',
                header: text.attempt,
                className: 'mono nowrap',
                render: (job) => `${job.attempt} / ${job.maxAttempts}`,
              },
              { key: 'created', priority: 'secondary', header: text.created, render: (job) => formatDate(job.createdAt) },
              {
                key: 'actions',
                priority: 'secondary',
                header: text.jobActions,
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
                    <span className="job-row-actions">
                      <button
                        className="button small"
                        onClick={() => setJobAction({ id: job.id, type: 'retry' })}
                      >
                        {text.retryJob}
                      </button>
                      {isResumableStatus(job.status) && !job.sweepEarlyStopped && (
                        <button
                          className="button small"
                          onClick={() => setJobAction({ id: job.id, type: 'resumeLatest' })}
                        >
                          {text.checkpointResumeLatest}
                        </button>
                      )}
                    </span>
                  )),
              },
            ]}
          />
        )}
      </Resource>
      {selected && (
        <section className="job-detail">
          <h2>{selected.runName}</h2>
          <DetailsList
            entries={[
              [text.jobColumn, <span className="mono">{selected.id}</span>],
              [text.status, <StatusBadge status={selected.status} earlyStopped={selected.sweepEarlyStopped} />],
              [text.heartbeat, formatDate(selected.heartbeatAt)],
              [text.exitCode, selected.exitCode],
              [text.jobError, selected.error],
            ]}
          />
          <Resource query={selectedRun}>
            {(run) => (
              <Resource query={sourceArtifacts}>
                {(artifacts) => (
                  <RunExecutionSnapshot run={run} artifacts={artifacts} taskName={selected.taskName} />
                )}
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
      {jobAction?.type === 'resumeLatest' && (
        <ResumeDialog
          projectId={project.id}
          jobId={jobAction.id}
          onClose={() => setJobAction(null)}
        />
      )}
      {(jobAction?.type === 'cancel' || jobAction?.type === 'retry') && (
        <FormDialog fullScreenOnNarrow
          title={jobAction.type === 'cancel' ? text.cancelJob : text.retryJob}
          onClose={() => setJobAction(null)}
          fields={[]}
          onSubmit={async () =>
            jobAction.type === 'cancel'
              ? { canceled: await executionApi.cancelJob(project.id, jobAction.id) }
              : executionApi.retryJob(project.id, jobAction.id, {})
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
