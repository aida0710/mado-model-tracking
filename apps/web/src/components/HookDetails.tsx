import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Hook } from '@mmt/contracts';
import type { HookCatalog } from '../types/hooks';
import { DetailsList, JsonDetails } from './JsonDetails';
import { HookStart } from './HookStart';
import { automationOwnerLabel } from '../lib/automationOwner';
import { buildCatalogOptions } from '../lib/catalogOptions';
import { creatorName } from '../lib/creatorName';
import { formatDate } from '../lib/format';
import { hookFilterEntries, hookResourceSummary, hookWebhookPath } from '../lib/hookDisplay';
import { hookFilterFields } from '../lib/hookInput';
import { formatAutoRetries } from '../lib/jobDisplay';
import { isSiteTarget } from '../lib/siteExecutionInput';
import { text } from '../i18n/catalog';
import {
  hookCheckpointModeLabels,
  hookConcurrencyLabels,
  hookTriggerLabels,
  hookWebhookSignatureLabels,
  hooksTextTemplates,
} from '../i18n/hooks';
import { submissionModeBadgeLabels } from '../i18n/compute';

type Entry = [string, ReactNode];

/** How a start is triggered: the trigger, its checkpoint rule or webhook, and its filter. */
function triggerEntries(hook: Hook, catalog: HookCatalog | undefined): Entry[] {
  const entries: Entry[] = [[text.hookTrigger, hookTriggerLabels[hook.trigger]]];
  if (hook.trigger === 'checkpoint_saved')
    entries.push([
      text.hookCheckpointMode,
      hook.checkpointMode === 'every_k' && hook.checkpointEvery !== null
        ? hooksTextTemplates.hookCheckpointEveryK(hook.checkpointEvery)
        : hookCheckpointModeLabels[hook.checkpointMode],
    ]);
  if (hook.trigger === 'webhook') {
    if (hook.webhookSignature)
      entries.push([text.hookWebhookSignature, hookWebhookSignatureLabels[hook.webhookSignature]]);
    entries.push([text.hookWebhookPath, <code className="mono">{hookWebhookPath(hook.id)}</code>]);
  }
  if (hookFilterFields(hook.trigger).length) {
    const filters = hookFilterEntries(hook.filter, catalog?.registry);
    entries.push(...(filters.length ? filters : ([[text.hookFilter, text.hookNoFilter]] satisfies Entry[])));
  }
  return entries;
}

/** The Job each start creates, with names in place of ids where the catalog has them. */
function templateEntries(hook: Hook, catalog: HookCatalog | undefined, base: string): Entry[] {
  const template = hook.template;
  const options = catalog ? buildCatalogOptions(catalog.registry) : undefined;
  const label = (list: 'experiments' | 'models' | 'codes' | 'datasets', id: string) =>
    options?.[list].find((option) => option.value === id)?.label ?? id;
  const target = catalog?.targets.find((item) => item.id === template.targetId);
  const isSite = isSiteTarget(target);
  const modelVersion = template.inheritModelVersion
    ? text.hookInheritModelVersion
    : hook.trigger === 'model_registered'
      ? text.hookRegisteredModelVersion
      : template.modelVersionId && (
          <Link to={`${base}/models?version=${template.modelVersionId}`}>
            {label('models', template.modelVersionId)}
          </Link>
        );
  return [
    [
      text.experiments,
      <Link to={`${base}/experiments?experiment=${template.experimentId}`}>
        {label('experiments', template.experimentId)}
      </Link>,
    ],
    [text.kind, text[template.kind]],
    [text.hookModelVersion, modelVersion || text.none],
    [
      text.codeVersion,
      <Link to={`${base}/codes?version=${template.codeVersionId}`}>
        {label('codes', template.codeVersionId)}
      </Link>,
    ],
    [
      text.inputDatasets,
      <>
        {template.inputDatasetVersionIds.map((id) => (
          <Link className="version-link" key={id} to={`${base}/datasets?version=${id}`}>
            {label('datasets', id)}
          </Link>
        ))}
        {template.inheritOutputDatasets && <span>{text.hookInheritOutputDatasets}</span>}
        {!template.inputDatasetVersionIds.length && !template.inheritOutputDatasets && text.none}
      </>,
    ],
    [
      text.target,
      <span className="badge-group">
        {target?.name ?? template.targetId}
        {target?.executor === 'site' && target.submissionMode === 'manual' && (
          <span className="status-badge status-attention">{submissionModeBadgeLabels.manual}</span>
        )}
      </span>,
    ],
    [text.hookResources, hookResourceSummary(template, isSite)],
    ...(template.datasetPartitionVersionId
      ? ([[text.hookDatasetPartition, label('datasets', template.datasetPartitionVersionId)]] satisfies Entry[])
      : []),
    [text.maxAttempts, template.maxAttempts],
    ...(isSite ? ([[text.jobAutoRetry, formatAutoRetries(template)]] satisfies Entry[]) : []),
    [text.jobAllowChildJobs, template.allowChildJobs ? text.enabled : text.disabled],
  ];
}

/** A hook's fixed settings, its manual start (trigger 'manual') and the way to its executions. */
export function HookDetails({
  hook,
  catalog,
  projectId,
  canStart,
  onShowExecutions,
  onStarted,
}: {
  hook: Hook;
  catalog: HookCatalog | undefined;
  projectId: string;
  canStart: boolean;
  onShowExecutions: () => void;
  onStarted: () => void;
}) {
  const base = `/projects/${projectId}`;
  return (
    <section className="automation-rule-detail" data-testid="hook-details">
      <div className="section-heading">
        <h3>{hook.name}</h3>
        <button className="button small" onClick={onShowExecutions}>
          {text.hookShowExecutions}
        </button>
      </div>
      <DetailsList
        entries={[
          ...triggerEntries(hook, catalog),
          ...templateEntries(hook, catalog, base),
          [text.hookConcurrency, hookConcurrencyLabels[hook.concurrency]],
          [text.hookMaxStartsPerHour, hook.maxStartsPerHour],
          [text.hookOwner, <span title={text.hookOwnerHint}>{automationOwnerLabel(hook)}</span>],
          [text.user, <span title={hook.createdBy}>{creatorName(hook)}</span>],
          [text.created, formatDate(hook.createdAt)],
        ]}
      />
      {hook.trigger === 'manual' && canStart && (
        <HookStart key={hook.id} hook={hook} projectId={projectId} onStarted={onStarted} />
      )}
      <details className="automation-settings">
        <summary>
          {text.parameters} / {text.tags}
        </summary>
        <JsonDetails value={hook.template.parameters} />
        <JsonDetails value={hook.template.tags} />
      </details>
      <p className="muted">{text.hookFixedSettings}</p>
    </section>
  );
}
