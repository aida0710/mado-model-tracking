import type { JobListItem } from '@mmt/contracts';
import { StatusBadge } from './StatusBadge';
import { isJobUnresponsive } from '../lib/jobLiveness';
import { jobDetailBadge } from '../lib/jobDisplay';
import { text } from '../i18n/catalog';

/**
 * A Job's status with what a site adds to it: the phase while it waits (manual submission,
 * scheduler queue, GPUs) or why it ended (time limit, queue limit, failed submission).
 */
export function JobStatusBadges({
  job,
}: {
  job: Pick<
    JobListItem,
    'status' | 'phase' | 'endReason' | 'heartbeatStale' | 'cancelRequested' | 'sweepEarlyStopped'
  >;
}) {
  const detail = jobDetailBadge(job);
  return (
    <span className="badge-group">
      <StatusBadge status={job.status} earlyStopped={job.sweepEarlyStopped} />
      {detail && <span className={`status-badge ${detail.className}`}>{detail.label}</span>}
      {isJobUnresponsive(job) && (
        // The red Job status color marks a silent worker; the Job status itself is unchanged.
        <span className="status-badge status-failed" title={text.jobUnresponsiveHint}>
          {text.jobUnresponsive}
        </span>
      )}
      {job.cancelRequested && !job.sweepEarlyStopped && <small>{text.cancelRequested}</small>}
    </span>
  );
}
