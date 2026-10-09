import { Link } from 'react-router-dom';
import type { ComputeTarget, Hook, JobListItem } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { JobStatusBadges } from './JobStatusBadges';
import { isResumableStatus } from '../lib/checkpointResume';
import { formatDate } from '../lib/format';
import { isActiveJob, jobArrayMemberLabel, jobGpuSummary, shortId } from '../lib/jobDisplay';
import { text } from '../i18n/catalog';

export type JobAction = 'cancel' | 'retry' | 'resumeLatest';

/** Where a site Job runs: the runner's host and the scheduler's job ID, once reported. */
function JobLocation({ job }: { job: Pick<JobListItem, 'runnerHost' | 'schedulerJobId'> }) {
  if (!job.runnerHost && !job.schedulerJobId) return <>—</>;
  return (
    <span className="job-cell-lines">
      {job.runnerHost && <span className="mono">{job.runnerHost}</span>}
      {job.schedulerJobId && (
        <span title={text.schedulerJobId}>
          <small className="muted">{text.schedulerJobIdShort} </small>
          <span className="mono">{job.schedulerJobId}</span>
        </span>
      )}
    </span>
  );
}

/** What started the Job besides a person: a hook, a driver Job (parent), or an array it belongs to. */
function JobOrigin({
  job,
  projectId,
  hooks,
  onSelectJob,
  onSelectArray,
}: {
  job: JobListItem;
  projectId: string;
  hooks: Hook[];
  onSelectJob: (jobId: string) => void;
  onSelectArray: (arrayGroupId: string) => void;
}) {
  const arrayMember = jobArrayMemberLabel(job);
  const { hookId, parentJobId, arrayGroupId } = job;
  if (!hookId && !parentJobId && !(arrayGroupId && arrayMember)) return <>—</>;
  return (
    <span className="job-cell-lines">
      {hookId && (
        <Link to={`/projects/${projectId}/hooks?hook=${hookId}`} title={hookId}>
          {text.jobHook}: {hooks.find((hook) => hook.id === hookId)?.name ?? shortId(hookId)}
        </Link>
      )}
      {parentJobId && (
        <button className="link-button" title={parentJobId} onClick={() => onSelectJob(parentJobId)}>
          {text.parentJob}: <span className="mono">{shortId(parentJobId)}</span>
        </button>
      )}
      {arrayGroupId && arrayMember && (
        <button className="link-button" title={arrayGroupId} onClick={() => onSelectArray(arrayGroupId)}>
          {text.jobArray} <span className="mono">{arrayMember}</span>
        </button>
      )}
    </span>
  );
}

/**
 * The Project's Jobs. Site Jobs add their phase or end reason to the status, where they run
 * (runner host, scheduler job ID) and what started them (hook, driver Job, array).
 */
export function JobsTable({
  jobs,
  targets,
  hooks,
  projectId,
  selectedId,
  canEdit,
  resumedRunIds,
  onSelectJob,
  onSelectArray,
  onAction,
}: {
  jobs: JobListItem[];
  targets: ComputeTarget[];
  hooks: Hook[];
  projectId: string;
  selectedId: string;
  canEdit: boolean;
  resumedRunIds: ReadonlySet<string> | undefined;
  onSelectJob: (jobId: string) => void;
  onSelectArray: (arrayGroupId: string) => void;
  onAction: (jobId: string, action: JobAction) => void;
}) {
  return (
    <ResponsiveTable
      rows={jobs}
      rowKey={(job) => job.id}
      selectedKey={selectedId}
      columns={[
        {
          key: 'id',
          priority: 'primary',
          header: text.jobColumn,
          render: (job) => (
            <button className="link-button mono" title={job.id} onClick={() => onSelectJob(job.id)}>
              {shortId(job.id)}
            </button>
          ),
        },
        {
          key: 'status',
          priority: 'primary',
          header: text.status,
          render: (job) => <JobStatusBadges job={job} />,
        },
        {
          key: 'run',
          priority: 'primary',
          header: text.jobRunColumn,
          className: 'job-run-cell',
          render: (job) => (
            <>
              <Link to={`/projects/${projectId}/runs/${job.runId}`} title={job.runId}>
                {job.runName}
              </Link>
              <small className="muted"> {text[job.runKind]}</small>
              {resumedRunIds?.has(job.runId) && (
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
              <Link to={`/projects/${projectId}/tasks?id=${job.taskId}`}>
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
          render: (job) => targets.find((target) => target.id === job.targetId)?.name ?? job.targetId,
        },
        {
          key: 'gpu',
          priority: 'secondary',
          header: text.gpuIds,
          className: 'mono nowrap',
          render: (job) => jobGpuSummary(job),
        },
        {
          key: 'where',
          priority: 'secondary',
          header: text.jobWhere,
          render: (job) => <JobLocation job={job} />,
        },
        {
          key: 'origin',
          priority: 'secondary',
          header: text.jobOrigin,
          render: (job) => (
            <JobOrigin
              job={job}
              projectId={projectId}
              hooks={hooks}
              onSelectJob={onSelectJob}
              onSelectArray={onSelectArray}
            />
          ),
        },
        {
          key: 'attempt',
          priority: 'secondary',
          header: text.attempt,
          className: 'mono nowrap',
          render: (job) => `${job.attempt} / ${job.maxAttempts}`,
        },
        {
          key: 'created',
          priority: 'secondary',
          header: text.created,
          render: (job) => formatDate(job.createdAt),
        },
        {
          key: 'actions',
          priority: 'secondary',
          header: text.jobActions,
          render: (job) =>
            canEdit &&
            (isActiveJob(job) ? (
              <button
                className="button small"
                disabled={job.cancelRequested}
                onClick={() => onAction(job.id, 'cancel')}
              >
                {text.cancelJob}
              </button>
            ) : (
              <span className="job-row-actions">
                <button className="button small" onClick={() => onAction(job.id, 'retry')}>
                  {text.retryJob}
                </button>
                {isResumableStatus(job.status) && !job.sweepEarlyStopped && (
                  <button className="button small" onClick={() => onAction(job.id, 'resumeLatest')}>
                    {text.checkpointResumeLatest}
                  </button>
                )}
              </span>
            )),
        },
      ]}
    />
  );
}
