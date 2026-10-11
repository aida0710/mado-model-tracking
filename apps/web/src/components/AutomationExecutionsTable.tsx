import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ModelAutomationExecution, ModelAutomationRule } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { ResponsiveTable, type ResponsiveTableColumn } from './ResponsiveTable';
import { StatusBadge } from './StatusBadge';
import { buildCatalogOptions } from '../lib/catalogOptions';
import { formatDate, formatDuration } from '../lib/format';
import { modelVersionPath } from '../lib/modelVersionPath';
import { text } from '../i18n/catalog';
import {
  automationOutcomeLabels,
  automationSkipReasonLabels,
  automationText,
} from '../i18n/automation';
import { automationSkipReason } from '../lib/automationSkipReason';
import { groupAutomationPipelines, type AutomationPipelineRow } from '../lib/automationPipelines';
import { canRerunExecution } from '../lib/automationRerun';
import { AutomationRerunButton } from './AutomationRerunButton';

function outcomeLabel(execution: ModelAutomationExecution): string {
  const skipReason = automationSkipReason(execution);
  return skipReason
    ? automationSkipReasonLabels[skipReason]
    : automationOutcomeLabels[execution.status];
}

function RuleCell({
  execution,
  ruleName,
}: {
  execution: ModelAutomationExecution;
  ruleName: string;
}) {
  return (
    <span>
      {ruleName}
      {execution.source === 'manual' && (
        <>
          {' '}
          <span className="status-badge status-queued">{automationText.manual}</span>
        </>
      )}
      {execution.attempt > 1 && (
        <span className="muted"> · {automationText.attemptLabel(execution.attempt)}</span>
      )}
      {execution.retryOfExecutionId && (
        <span className="muted"> · {automationText.retryOf(execution.attempt - 1)}</span>
      )}
    </span>
  );
}

function ModelVersionLink({
  projectId,
  modelVersionId,
  catalog,
}: {
  projectId: string;
  modelVersionId: string;
  catalog?: ExecutionCatalog;
}) {
  const version = catalog?.modelVersions.find((item) => item.id === modelVersionId);
  const label = catalog
    ? (buildCatalogOptions(catalog).models.find((option) => option.value === modelVersionId)
        ?.label ?? modelVersionId)
    : modelVersionId;
  // The version page needs the Model id; without the catalog the registry resolves the version.
  const to = version
    ? modelVersionPath(projectId, { modelId: version.modelId, versionId: version.id })
    : `/projects/${projectId}/models?version=${modelVersionId}`;
  return <Link to={to}>{label}</Link>;
}

/**
 * Automation executions grouped by pipeline. The 'project' variant lists every version; the
 * 'version' variant is one version's history, so it drops the version column and adds the rule's
 * kind and the Run's duration. onRerun is given only to Project admins, who may apply a rule again.
 */
export function AutomationExecutionsTable({
  executions,
  rules,
  projectId,
  catalog,
  variant = 'project',
  onRerun,
}: {
  executions: ModelAutomationExecution[];
  rules: ModelAutomationRule[];
  projectId: string;
  catalog?: ExecutionCatalog;
  variant?: 'project' | 'version';
  onRerun?: () => void;
}) {
  const base = `/projects/${projectId}`;
  const rows = groupAutomationPipelines(executions, rules);
  const column = (render: (execution: ModelAutomationExecution) => ReactNode) =>
    (row: AutomationPipelineRow) => render(row.execution);
  const ruleOf = (execution: ModelAutomationExecution) =>
    rules.find((rule) => rule.id === execution.ruleId);
  const versionColumns: ResponsiveTableColumn<AutomationPipelineRow>[] =
    variant === 'version'
      ? [
          {
            key: 'kind',
            priority: 'secondary',
            header: text.kind,
            render: column((execution) => {
              const rule = ruleOf(execution);
              return rule ? text[rule.kind] : '—';
            }),
          },
        ]
      : [
          {
            key: 'model',
            priority: 'secondary',
            // Each cell names the model, so the header needs only the shorter word.
            header: text.version,
            render: column((execution) => (
              <ModelVersionLink
                projectId={projectId}
                modelVersionId={execution.modelVersionId}
                catalog={catalog}
              />
            )),
          },
        ];
  const durationColumns: ResponsiveTableColumn<AutomationPipelineRow>[] =
    variant === 'version'
      ? [
          {
            key: 'duration',
            priority: 'secondary',
            header: text.duration,
            className: 'nowrap',
            render: column((execution) =>
              formatDuration(execution.runStartedAt ?? null, execution.runEndedAt ?? null),
            ),
          },
        ]
      : [];
  const rerunColumns: ResponsiveTableColumn<AutomationPipelineRow>[] = onRerun
    ? [
        {
          key: 'rerun',
          priority: 'secondary',
          header: automationText.rerun,
          render: column((execution) => {
            const rule = ruleOf(execution);
            return rule && canRerunExecution(execution, rule) ? (
              <AutomationRerunButton
                execution={execution}
                rule={rule}
                projectId={projectId}
                onRerun={onRerun}
              />
            ) : null;
          }),
        },
      ]
    : [];
  return (
    <ResponsiveTable
      rows={rows}
      rowKey={(row) => row.execution.id}
      empty={text.automationNoExecutions}
      columns={[
        {
          key: 'stage',
          priority: 'primary',
          header: automationText.stage,
          className: 'nowrap',
          render: (row) =>
            row.isPipelineStart
              ? automationText.stageLabel(row.stage)
              : `└ ${automationText.stageLabel(row.stage)}`,
        },
        {
          key: 'created',
          priority: 'secondary',
          header: text.created,
          render: column((execution) => formatDate(execution.createdAt)),
        },
        {
          key: 'rule',
          priority: 'primary',
          header: text.automationRule,
          render: column((execution) => (
            <RuleCell execution={execution} ruleName={ruleOf(execution)?.name ?? execution.ruleId} />
          )),
        },
        ...versionColumns,
        {
          key: 'outcome',
          priority: 'primary',
          header: text.automationOutcome,
          render: column((execution) =>
            execution.status === 'pending' ? (
              <span title={automationText.pendingHint}>{outcomeLabel(execution)}</span>
            ) : (
              outcomeLabel(execution)
            ),
          ),
        },
        {
          key: 'run-status',
          priority: 'secondary',
          header: text.automationRunStatus,
          render: column((execution) =>
            execution.runStatus ? <StatusBadge status={execution.runStatus} /> : '—',
          ),
        },
        {
          key: 'job-status',
          priority: 'secondary',
          header: text.automationJobStatus,
          render: column((execution) =>
            execution.jobStatus ? <StatusBadge status={execution.jobStatus} /> : '—',
          ),
        },
        ...durationColumns,
        {
          key: 'links',
          priority: 'secondary',
          header: text.details,
          render: column((execution) => (
            <div className="automation-links">
              {execution.sourceRunId && (
                <Link to={`${base}/runs/${execution.sourceRunId}`}>{automationText.sourceRun}</Link>
              )}
              {execution.triggerRunId && (
                <Link to={`${base}/runs/${execution.triggerRunId}`}>
                  {automationText.triggerRun}
                </Link>
              )}
              {execution.runId && (
                <Link to={`${base}/runs/${execution.runId}`}>{text.automationRun}</Link>
              )}
              {execution.jobId && (
                <Link to={`${base}/jobs?job=${execution.jobId}`}>{text.automationJob}</Link>
              )}
              {!execution.sourceRunId &&
                !execution.triggerRunId &&
                !execution.runId &&
                !execution.jobId &&
                '—'}
            </div>
          )),
        },
        {
          key: 'error',
          priority: 'secondary',
          header: text.jobError,
          render: column((execution) => (
            <span className="automation-error">{execution.error ?? '—'}</span>
          )),
        },
        ...rerunColumns,
      ]}
    />
  );
}
