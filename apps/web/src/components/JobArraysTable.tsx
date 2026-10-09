import { Link } from 'react-router-dom';
import type { ComputeTarget, Hook } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { formatDate } from '../lib/format';
import { JOB_ARRAY_STATE_ORDER, type JobArraySummary } from '../lib/jobArrays';
import { shortId } from '../lib/jobDisplay';
import { text } from '../i18n/catalog';
import { jobsTextTemplates } from '../i18n/jobs';

function ArrayStates({ counts }: { counts: JobArraySummary['counts'] }) {
  return (
    <span className="badge-group">
      {JOB_ARRAY_STATE_ORDER.map((status) => {
        const count = counts[status];
        return count ? (
          <span key={status} className={`status-badge status-${status}`}>
            {jobsTextTemplates.jobArrayState(text[status], count)}
          </span>
        ) : null;
      })}
    </span>
  );
}

/** Job arrays among the listed Jobs, with how many members are in each state. */
export function JobArraysTable({
  arrays,
  targets,
  hooks,
  projectId,
  selectedArrayId,
  onSelectArray,
  onSelectJob,
}: {
  arrays: JobArraySummary[];
  targets: ComputeTarget[];
  hooks: Hook[];
  projectId: string;
  selectedArrayId: string;
  onSelectArray: (arrayGroupId: string) => void;
  onSelectJob: (jobId: string) => void;
}) {
  return (
    <section className="job-arrays">
      <h2>{text.jobArrays}</h2>
      <p className="muted">{text.jobArrayCountsHint}</p>
      <ResponsiveTable
        rows={arrays}
        rowKey={(array) => array.arrayGroupId}
        selectedKey={selectedArrayId}
        columns={[
          {
            key: 'array',
            priority: 'primary',
            header: text.jobArray,
            render: (array) => (
              <button
                className="link-button mono"
                title={array.arrayGroupId}
                aria-label={`${text.jobArrayShowJobs}: ${array.arrayGroupId}`}
                onClick={() => onSelectArray(array.arrayGroupId)}
              >
                {shortId(array.arrayGroupId)}
              </button>
            ),
          },
          {
            key: 'states',
            priority: 'primary',
            header: text.jobArrayStates,
            render: (array) => <ArrayStates counts={array.counts} />,
          },
          {
            key: 'size',
            priority: 'secondary',
            header: text.jobArraySize,
            className: 'mono',
            render: (array) => array.size,
          },
          {
            key: 'target',
            priority: 'secondary',
            header: text.target,
            render: (array) =>
              targets.find((target) => target.id === array.targetId)?.name ?? array.targetId,
          },
          {
            key: 'origin',
            priority: 'secondary',
            header: text.jobOrigin,
            render: ({ hookId, parentJobId }) => (
              <span className="job-cell-lines">
                {hookId && (
                  <Link to={`/projects/${projectId}/hooks?hook=${hookId}`} title={hookId}>
                    {text.jobHook}: {hooks.find((hook) => hook.id === hookId)?.name ?? shortId(hookId)}
                  </Link>
                )}
                {parentJobId && (
                  <button
                    className="link-button"
                    title={parentJobId}
                    onClick={() => onSelectJob(parentJobId)}
                  >
                    {text.parentJob}: <span className="mono">{shortId(parentJobId)}</span>
                  </button>
                )}
                {!hookId && !parentJobId && '—'}
              </span>
            ),
          },
          {
            key: 'created',
            priority: 'secondary',
            header: text.created,
            render: (array) => formatDate(array.createdAt),
          },
        ]}
      />
    </section>
  );
}
