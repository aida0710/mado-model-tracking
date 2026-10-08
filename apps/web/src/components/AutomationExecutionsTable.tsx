import { Link } from 'react-router-dom';
import type { ModelAutomationExecution, ModelAutomationRule } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { DataTable } from './DataTable';
import { StatusBadge } from './StatusBadge';
import { buildCatalogOptions } from '../lib/catalogOptions';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';
import {
  automationOutcomeLabels,
  automationSourceRunSkipLabels,
  automationText,
} from '../i18n/automation';
import { sourceRunSkipReason } from '../lib/automationSourceRunSkip';

function outcomeLabel(execution: ModelAutomationExecution): string {
  const skipReason = sourceRunSkipReason(execution);
  return skipReason
    ? automationSourceRunSkipLabels[skipReason]
    : automationOutcomeLabels[execution.status];
}

export function AutomationExecutionsTable({
  executions,
  rules,
  projectId,
  catalog,
}: {
  executions: ModelAutomationExecution[];
  rules: ModelAutomationRule[];
  projectId: string;
  catalog?: ExecutionCatalog;
}) {
  const modelOptions = catalog ? buildCatalogOptions(catalog).models : [];
  const base = `/projects/${projectId}`;
  return (
    <DataTable
      items={executions}
      rowKey={(execution) => execution.id}
      empty={text.automationNoExecutions}
      columns={[
        {
          key: 'created',
          label: text.created,
          render: (execution) => formatDate(execution.createdAt),
        },
        {
          key: 'rule',
          label: text.automationRule,
          render: (execution) =>
            rules.find((rule) => rule.id === execution.ruleId)?.name ?? execution.ruleId,
        },
        {
          key: 'model',
          label: text.modelVersion,
          render: (execution) => (
            <Link to={`${base}/models?version=${execution.modelVersionId}`}>
              {modelOptions.find((option) => option.value === execution.modelVersionId)?.label ??
                execution.modelVersionId}
            </Link>
          ),
        },
        {
          key: 'outcome',
          label: text.automationOutcome,
          render: (execution) =>
            execution.status === 'pending' ? (
              <span title={automationText.pendingHint}>{outcomeLabel(execution)}</span>
            ) : (
              outcomeLabel(execution)
            ),
        },
        {
          key: 'run-status',
          label: text.automationRunStatus,
          render: (execution) =>
            execution.runStatus ? <StatusBadge status={execution.runStatus} /> : '—',
        },
        {
          key: 'job-status',
          label: text.automationJobStatus,
          render: (execution) =>
            execution.jobStatus ? <StatusBadge status={execution.jobStatus} /> : '—',
        },
        {
          key: 'links',
          label: text.details,
          render: (execution) => (
            <div className="automation-links">
              {execution.sourceRunId && (
                <Link to={`${base}/runs/${execution.sourceRunId}`}>{automationText.sourceRun}</Link>
              )}
              {execution.runId && (
                <Link to={`${base}/runs/${execution.runId}`}>{text.automationRun}</Link>
              )}
              {execution.jobId && (
                <Link to={`${base}/jobs?job=${execution.jobId}`}>{text.automationJob}</Link>
              )}
              {!execution.sourceRunId && !execution.runId && !execution.jobId && '—'}
            </div>
          ),
        },
        {
          key: 'error',
          label: text.jobError,
          render: (execution) => <span className="automation-error">{execution.error ?? '—'}</span>,
        },
      ]}
    />
  );
}
