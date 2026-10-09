import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ComputeTarget, Hook, JobListItem } from '@mmt/contracts';
import { DetailsList } from './JsonDetails';
import { JobStatusBadges } from './JobStatusBadges';
import { formatClockDuration } from '../lib/clockDuration';
import { formatDate } from '../lib/format';
import {
  formatAutoRetries,
  jobArrayMemberLabel,
  jobGpuSummary,
  jobPhaseText,
} from '../lib/jobDisplay';
import { isSiteTarget } from '../lib/siteExecutionInput';
import { text } from '../i18n/catalog';
import { jobEndReasonLabels } from '../i18n/jobs';

type Entry = [string, ReactNode];

/** The site fields of a Job; ssh/local Jobs have none of them. */
function siteEntries(job: JobListItem): Entry[] {
  return [
    [text.jobPhase, jobPhaseText(job, true)],
    [text.walltimeShort, formatClockDuration(job.walltimeSeconds) || text.walltimeUnset],
    [text.schedulerJobId, job.schedulerJobId && <span className="mono">{job.schedulerJobId}</span>],
    [text.jobSubmittedAt, job.submittedAt && formatDate(job.submittedAt)],
    [text.runnerHost, job.runnerHost && <span className="mono">{job.runnerHost}</span>],
    [text.jobAutoRetry, formatAutoRetries(job)],
  ];
}

/** Where the Job came from: an array, a driver Job, a hook, and how deep in a chain it is. */
function originEntries({
  job,
  hooks,
  projectId,
  onSelectJob,
  onSelectArray,
}: {
  job: JobListItem;
  hooks: Hook[];
  projectId: string;
  onSelectJob: (jobId: string) => void;
  onSelectArray: (arrayGroupId: string) => void;
}): Entry[] {
  const entries: Entry[] = [];
  const arrayMember = jobArrayMemberLabel(job);
  const { arrayGroupId, parentJobId, hookId } = job;
  if (arrayGroupId && arrayMember)
    entries.push([
      text.jobArray,
      <button className="link-button" title={arrayGroupId} onClick={() => onSelectArray(arrayGroupId)}>
        <span className="mono">{arrayMember}</span> · {text.jobArrayShowJobs}
      </button>,
    ]);
  if (parentJobId)
    entries.push([
      text.parentJob,
      <button className="link-button mono" onClick={() => onSelectJob(parentJobId)}>
        {parentJobId}
      </button>,
    ]);
  if (hookId)
    entries.push([
      text.jobHook,
      <Link to={`/projects/${projectId}/hooks?hook=${hookId}`}>
        {hooks.find((hook) => hook.id === hookId)?.name ?? hookId}
      </Link>,
    ]);
  if (job.chainDepth > 0) entries.push([text.jobChainDepth, job.chainDepth]);
  if (job.allowChildJobs) entries.push([text.jobAllowChildJobs, text.enabled]);
  return entries;
}

/** The selected Job's fields on the Jobs page. */
export function JobDetailsList({
  job,
  target,
  hooks,
  projectId,
  onSelectJob,
  onSelectArray,
}: {
  job: JobListItem;
  target: ComputeTarget | undefined;
  hooks: Hook[];
  projectId: string;
  onSelectJob: (jobId: string) => void;
  onSelectArray: (arrayGroupId: string) => void;
}) {
  return (
    <DetailsList
      entries={[
        [text.jobColumn, <span className="mono">{job.id}</span>],
        [text.status, <JobStatusBadges job={job} />],
        ...(job.endReason
          ? ([[text.jobEndReason, jobEndReasonLabels[job.endReason]]] satisfies Entry[])
          : []),
        [text.gpuIds, <span className="mono">{jobGpuSummary(job)}</span>],
        // A phase marks a site Job even before the targets are read.
        ...(isSiteTarget(target) || Boolean(job.phase) ? siteEntries(job) : []),
        ...originEntries({ job, hooks, projectId, onSelectJob, onSelectArray }),
        [text.heartbeat, formatDate(job.heartbeatAt)],
        [text.exitCode, job.exitCode],
        [text.jobError, job.error],
      ]}
    />
  );
}
