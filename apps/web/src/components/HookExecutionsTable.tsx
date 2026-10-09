import { Link } from 'react-router-dom';
import type { Hook, HookExecution } from '@mmt/contracts';
import { ResponsiveTable, type ResponsiveTableColumn } from './ResponsiveTable';
import { StatusBadge } from './StatusBadge';
import { formatDate } from '../lib/format';
import { hookExecutionOutcome } from '../lib/hookDisplay';
import { shortId } from '../lib/jobDisplay';
import { text } from '../i18n/catalog';
import { hookExecutionSubjectLabels } from '../i18n/hooks';

/** The event a start came from, linked to its page where there is one. */
function ExecutionSubject({ execution, base }: { execution: HookExecution; base: string }) {
  const label = hookExecutionSubjectLabels[execution.subjectKind];
  const id = execution.subjectId;
  if (!id) return <>{label}</>;
  const shown = <span className="mono">{shortId(id)}</span>;
  switch (execution.subjectKind) {
    case 'model_version':
      return <Link to={`${base}/models?version=${id}`} title={id}>{label} {shown}</Link>;
    case 'run':
      return <Link to={`${base}/runs/${id}`} title={id}>{label} {shown}</Link>;
    case 'array_group':
      return <Link to={`${base}/jobs?array=${id}`} title={id}>{label} {shown}</Link>;
    default:
      // A manual start's key, a webhook delivery ID or a checkpoint: no page of its own.
      return <span title={id}>{label} {shown}</span>;
  }
}

/** What the start created or waits for. */
function ExecutionLinks({ execution, base }: { execution: HookExecution; base: string }) {
  const { runId, jobId, arrayGroupId, waitingRunId } = execution;
  if (!runId && !jobId && !arrayGroupId && !waitingRunId) return <>—</>;
  return (
    <div className="automation-links">
      {runId && <Link to={`${base}/runs/${runId}`}>{text.automationRun}</Link>}
      {jobId && <Link to={`${base}/jobs?job=${jobId}`}>{text.automationJob}</Link>}
      {arrayGroupId && <Link to={`${base}/jobs?array=${arrayGroupId}`}>{text.jobArray}</Link>}
      {waitingRunId && <Link to={`${base}/runs/${waitingRunId}`}>{text.hookExecutionWaitingRun}</Link>}
    </div>
  );
}

/**
 * Starts of the Project's hooks, newest first. The hook column is left out when the list shows
 * one hook's executions.
 */
export function HookExecutionsTable({
  executions,
  hooks,
  projectId,
  showHook,
}: {
  executions: HookExecution[];
  hooks: Hook[];
  projectId: string;
  showHook: boolean;
}) {
  const base = `/projects/${projectId}`;
  const hookColumns: ResponsiveTableColumn<HookExecution>[] = showHook
    ? [
        {
          key: 'hook',
          priority: 'primary',
          header: text.hookList,
          render: (execution) => (
            <Link to={`${base}/hooks?hook=${execution.hookId}`}>
              {hooks.find((hook) => hook.id === execution.hookId)?.name ?? shortId(execution.hookId)}
            </Link>
          ),
        },
      ]
    : [];
  return (
    <ResponsiveTable
      rows={executions}
      rowKey={(execution) => execution.id}
      empty={text.noHookExecutions}
      columns={[
        {
          key: 'created',
          priority: 'primary',
          header: text.created,
          className: 'nowrap',
          render: (execution) => formatDate(execution.createdAt),
        },
        ...hookColumns,
        {
          key: 'outcome',
          priority: 'primary',
          header: text.hookExecutionOutcome,
          render: (execution) => hookExecutionOutcome(execution),
        },
        {
          key: 'subject',
          priority: 'secondary',
          header: text.hookExecutionSubject,
          render: (execution) => <ExecutionSubject execution={execution} base={base} />,
        },
        {
          key: 'job-status',
          priority: 'secondary',
          header: text.automationJobStatus,
          render: (execution) =>
            execution.jobStatus ? <StatusBadge status={execution.jobStatus} /> : '—',
        },
        {
          key: 'links',
          priority: 'secondary',
          header: text.hookExecutionLinks,
          render: (execution) => <ExecutionLinks execution={execution} base={base} />,
        },
        {
          key: 'error',
          priority: 'secondary',
          header: text.jobError,
          render: (execution) => <span className="automation-error">{execution.error ?? '—'}</span>,
        },
      ]}
    />
  );
}
