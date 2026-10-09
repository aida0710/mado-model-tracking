import type { Job, JobPhase, JobStatus } from '@mmt/contracts';
import { text } from '../i18n/catalog';
import { jobEndReasonLabels, jobPhaseLabels, jobsTextTemplates } from '../i18n/jobs';

const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'claimed', 'running'];
// The full id stays in the title; eight characters tell Jobs, hooks and arrays apart in a Project.
const SHORT_ID_LENGTH = 8;

export const shortId = (id: string): string => id.slice(0, SHORT_ID_LENGTH);

export interface JobBadge {
  label: string;
  /** A status color class of tables.css. */
  className: string;
}

// waiting_manual waits for a person; the other phases are on their way like a claimed Job.
const phaseBadgeClass: Record<Exclude<JobPhase, 'running'>, string> = {
  waiting_manual: 'status-attention',
  submitting: 'status-claimed',
  submitted: 'status-claimed',
  waiting_resources: 'status-claimed',
};

export const isActiveJob = (job: Pick<Job, 'status'>): boolean =>
  ACTIVE_JOB_STATUSES.includes(job.status);

/**
 * The badge beside a Job's status: where an active site Job is between queued and running, or why
 * an ended site Job stopped. null when it would only repeat the status (a running container), for
 * ssh/local Jobs, which have no phase, and for an ended Job without a site reason.
 */
export function jobDetailBadge(job: Pick<Job, 'status' | 'phase' | 'endReason'>): JobBadge | null {
  if (!isActiveJob(job))
    return job.endReason
      ? { label: jobEndReasonLabels[job.endReason], className: 'status-failed' }
      : null;
  if (!job.phase || job.phase === 'running') return null;
  return { label: jobPhaseLabels[job.phase], className: phaseBadgeClass[job.phase] };
}

/**
 * The phase of a site Job for its details. A queued site Job without a phase waits for the
 * launcher; an ended Job keeps the last phase it reached.
 */
export function jobPhaseText(job: Pick<Job, 'status' | 'phase'>, isSite: boolean): string | null {
  if (job.phase) return jobPhaseLabels[job.phase];
  return isSite && job.status === 'queued' ? text.jobLauncherWaiting : null;
}

/**
 * The GPUs of a Job: the IDs it holds, or the count a site Job asked for before its runner
 * reported the IDs (ssh/local Jobs always hold as many IDs as their count).
 */
export function jobGpuSummary(job: Pick<Job, 'gpuIds' | 'gpuCount'>): string {
  if (job.gpuIds.length) return job.gpuIds.join(', ');
  return job.gpuCount > 0 ? jobsTextTemplates.gpuCount(job.gpuCount) : text.cpuOnly;
}

/** "index / size" of an array member; null for a Job outside an array. */
export function jobArrayMemberLabel(job: Pick<Job, 'arrayIndex' | 'arraySize'>): string | null {
  if (job.arrayIndex === null || job.arraySize === null) return null;
  return jobsTextTemplates.arrayMember(job.arrayIndex, job.arraySize);
}

/** The automatic retries a site Job (or a hook's Jobs) asked for, or "none". */
export function formatAutoRetries(flags: Pick<Job, 'retryOnFailure' | 'retryOnTimeout'>): string {
  const retries = [
    flags.retryOnFailure && text.jobRetryOnFailure,
    flags.retryOnTimeout && text.jobRetryOnTimeout,
  ].filter(Boolean);
  return retries.join(' / ') || text.none;
}
