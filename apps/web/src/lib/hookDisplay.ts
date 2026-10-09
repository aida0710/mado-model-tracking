import type { Hook, HookExecution, HookFilter } from '@mmt/contracts';
export { hookWebhookPath } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { formatClockDuration } from './clockDuration';
import { jobGpuSummary } from './jobDisplay';
import { text } from '../i18n/catalog';
import {
  hookExecutionStatusLabels,
  hookSkipReasonLabels,
  hooksTextTemplates,
} from '../i18n/hooks';
import { jobsTextTemplates } from '../i18n/jobs';

/** What came of one start: queued, failed, waiting for a Run, or skipped with its reason. */
export function hookExecutionOutcome(execution: Pick<HookExecution, 'status' | 'reason'>): string {
  if (execution.status === 'skipped' && execution.reason)
    return hooksTextTemplates.hookSkipped(hookSkipReasonLabels[execution.reason]);
  return hookExecutionStatusLabels[execution.status];
}


/** The filter of a hook as label and value pairs; names stand in for ids where they are known. */
export function hookFilterEntries(
  filter: HookFilter,
  catalog: Pick<ExecutionCatalog, 'experiments'> | undefined,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (filter.modelFamilies?.length)
    entries.push([text.hookFilterModelFamilies, filter.modelFamilies.join(', ')]);
  if (filter.experimentIds?.length)
    entries.push([
      text.hookFilterExperiments,
      filter.experimentIds
        .map((id) => catalog?.experiments.find((experiment) => experiment.id === id)?.name ?? id)
        .join(', '),
    ]);
  if (filter.runKinds?.length)
    entries.push([text.hookFilterRunKinds, filter.runKinds.map((kind) => text[kind]).join(', ')]);
  if (filter.runStatuses?.length)
    entries.push([
      text.hookFilterRunStatuses,
      filter.runStatuses.map((status) => text[status]).join(', '),
    ]);
  if (filter.tags && Object.keys(filter.tags).length)
    entries.push([text.hookFilterTags, JSON.stringify(filter.tags)]);
  return entries;
}

/** The resources a hook's Jobs ask for: GPU IDs, or a site's count, time limit and array. */
export function hookResourceSummary(template: Hook['template'], isSite: boolean): string {
  if (!isSite) return jobGpuSummary(template);
  const parts = [
    jobGpuSummary({ gpuIds: [], gpuCount: template.gpuCount }),
    `${text.walltimeShort} ${formatClockDuration(template.walltimeSeconds) || text.walltimeUnset}`,
  ];
  if (template.arraySize !== null) parts.push(jobsTextTemplates.arraySize(template.arraySize));
  return parts.join(' · ');
}
