import {
  HOOK_CHECKPOINT_MODES,
  HOOK_CONCURRENCY_MODES,
  HOOK_TRIGGERS,
  HOOK_WEBHOOK_SIGNATURES,
  MAX_HOOK_CHECKPOINT_EVERY,
  MAX_HOOK_MAX_STARTS_PER_HOUR,
  MAX_JOB_ARRAY_SIZE,
  MAX_JOB_GPU_COUNT,
  type HookTrigger,
} from '@mmt/contracts';
import type { FormField, FormValues } from '../types/form';
import type { HookCatalog } from '../types/hooks';
import { FormFields } from './FormFields';
import { CodeRuntimeDetails } from './CodeRuntimeDetails';
import { getFieldValue } from '../lib/formValues';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import { MAX_JOB_ATTEMPTS, RUN_KINDS } from '../lib/executionValidation';
import { isTargetCompatible } from '../lib/runtimeValidation';
import { isSiteTarget } from '../lib/siteExecutionInput';
import { targetChoiceLabel } from '../lib/computeTargetDisplay';
import {
  HOOK_RUN_END_STATUSES,
  INHERIT_MODEL_VERSION,
  canInheritModelVersion,
  canInheritOutputDatasets,
  hookFilterFields,
  hookModelFamilies,
  isHookCodeCompatible,
  partitionCandidates,
  usesRegisteredModelVersion,
} from '../lib/hookInput';
import { text } from '../i18n/catalog';
import { automationText } from '../i18n/automation';
import {
  hookCheckpointModeLabels,
  hookConcurrencyLabels,
  hookTriggerLabels,
  hookWebhookSignatureLabels,
} from '../i18n/hooks';

/**
 * The hook create form: the trigger and its filter, the Job each start creates (with the site
 * resources when the target is a site), and the limits on how often it starts.
 */
export function HookFields({
  values,
  catalog,
  onChange,
}: {
  values: FormValues;
  catalog: HookCatalog;
  onChange: (values: FormValues) => void;
}) {
  const choices = catalog.registry;
  const options = buildCatalogOptions(choices);
  const trigger = getFieldValue(values, 'trigger') as HookTrigger;
  const filterFields = hookFilterFields(trigger);
  const compatibleCodes = choices.codeVersions.filter((code) =>
    isHookCodeCompatible(code, values, catalog),
  );
  const code = compatibleCodes.find((version) => version.id === getFieldValue(values, 'codeVersionId'));
  const compatibleTargets = catalog.targets.filter((target) => code && isTargetCompatible(target, code));
  const target = compatibleTargets.find((item) => item.id === getFieldValue(values, 'targetId'));
  const isSite = isSiteTarget(target);
  const hasArray = getFieldValue(values, 'arraySize').trim() !== '';
  const triggerFields: FormField[] = [
    { name: 'name', label: text.name, required: true },
    {
      name: 'trigger',
      label: text.hookTrigger,
      type: 'select',
      required: true,
      options: HOOK_TRIGGERS.map((item) => ({ value: item, label: hookTriggerLabels[item] })),
    },
    {
      name: 'webhookSignature',
      label: text.hookWebhookSignature,
      type: 'select',
      required: true,
      visible: () => trigger === 'webhook',
      options: HOOK_WEBHOOK_SIGNATURES.map((item) => ({
        value: item,
        label: hookWebhookSignatureLabels[item],
      })),
    },
    {
      name: 'checkpointMode',
      label: text.hookCheckpointMode,
      type: 'select',
      visible: () => trigger === 'checkpoint_saved',
      options: HOOK_CHECKPOINT_MODES.map((item) => ({
        value: item,
        label: hookCheckpointModeLabels[item],
      })),
    },
    {
      name: 'checkpointEvery',
      label: text.hookCheckpointEvery,
      type: 'number',
      required: true,
      min: 1,
      max: MAX_HOOK_CHECKPOINT_EVERY,
      visible: (current) =>
        trigger === 'checkpoint_saved' && getFieldValue(current, 'checkpointMode') === 'every_k',
    },
  ];
  const filterFormFields: FormField[] = [
    {
      name: 'filterModelFamilies',
      label: text.hookFilterModelFamilies,
      type: 'multiselect',
      visible: () => filterFields.includes('modelFamilies'),
      options: hookModelFamilies(catalog).map((family) => ({ value: family, label: family })),
    },
    {
      name: 'filterExperimentIds',
      label: text.hookFilterExperiments,
      type: 'multiselect',
      visible: () => filterFields.includes('experimentIds'),
      options: options.experiments,
    },
    {
      name: 'filterRunKinds',
      label: text.hookFilterRunKinds,
      type: 'multiselect',
      visible: () => filterFields.includes('runKinds'),
      options: RUN_KINDS.map((item) => ({ value: item, label: text[item] })),
    },
    {
      name: 'filterRunStatuses',
      label: text.hookFilterRunStatuses,
      type: 'multiselect',
      visible: () => filterFields.includes('runStatuses'),
      options: HOOK_RUN_END_STATUSES.map((item) => ({ value: item, label: text[item] })),
    },
    {
      name: 'filterTags',
      label: text.hookFilterTags,
      type: 'textarea',
      visible: () => filterFields.includes('tags'),
    },
  ];
  const templateFields: FormField[] = [
    {
      name: 'experimentId',
      label: text.experiments,
      type: 'select',
      required: true,
      options: withEmptyOption(options.experiments),
    },
    {
      name: 'kind',
      label: text.kind,
      type: 'select',
      required: true,
      options: RUN_KINDS.map((item) => ({ value: item, label: text[item] })),
    },
    {
      name: 'modelVersionId',
      label: text.hookModelVersion,
      type: 'select',
      visible: () => !usesRegisteredModelVersion(trigger),
      options: [
        { value: '', label: text.none },
        ...(canInheritModelVersion(trigger)
          ? [{ value: INHERIT_MODEL_VERSION, label: text.hookInheritModelVersion }]
          : []),
        ...options.models,
      ],
    },
    {
      name: 'codeVersionId',
      label: text.codeVersion,
      type: 'select',
      required: true,
      options: withEmptyOption(
        options.codes.filter((option) => compatibleCodes.some((version) => version.id === option.value)),
      ),
    },
    {
      name: 'inputDatasetVersionIds',
      label: text.inputDatasets,
      type: 'multiselect',
      options: options.datasets,
    },
    {
      name: 'inheritOutputDatasets',
      label: text.hookInheritOutputDatasets,
      type: 'checkbox',
      visible: () => canInheritOutputDatasets(trigger),
    },
    {
      name: 'targetId',
      label: text.target,
      type: 'select',
      required: true,
      options: withEmptyOption(
        compatibleTargets.map((item) => ({ value: item.id, label: targetChoiceLabel(item) })),
      ),
    },
    {
      name: 'gpuIds',
      label: `${text.gpuIds} · ${text.cpuOnly}`,
      type: 'multiselect',
      visible: () => !isSite,
      options: (target?.gpuIds ?? []).map((id) => ({ value: id, label: id })),
    },
    {
      name: 'gpuCount',
      label: text.gpuCount,
      type: 'number',
      min: 0,
      max: MAX_JOB_GPU_COUNT,
      visible: () => isSite,
    },
    {
      name: 'walltime',
      label: text.walltime,
      placeholder: text.walltimePlaceholder,
      visible: () => isSite,
    },
    {
      name: 'arraySize',
      label: text.hookArraySize,
      type: 'number',
      min: 1,
      max: MAX_JOB_ARRAY_SIZE,
      visible: () => isSite,
    },
    {
      name: 'datasetPartitionVersionId',
      label: text.hookDatasetPartition,
      type: 'select',
      visible: () => isSite && hasArray,
      options: withEmptyOption(
        partitionCandidates(values, catalog).map((version) => ({
          value: version.id,
          label: options.datasets.find((option) => option.value === version.id)?.label ?? version.id,
        })),
      ),
    },
    { name: 'parameters', label: text.parametersJson, type: 'textarea' },
    { name: 'tags', label: text.tagsJson, type: 'textarea' },
    {
      name: 'maxAttempts',
      label: automationText.maxAttempts,
      type: 'number',
      required: true,
      min: 1,
      max: MAX_JOB_ATTEMPTS,
    },
    {
      name: 'retryOnFailure',
      label: text.jobRetryOnFailure,
      type: 'checkbox',
      visible: () => isSite,
    },
    {
      name: 'retryOnTimeout',
      label: text.jobRetryOnTimeout,
      type: 'checkbox',
      visible: () => isSite,
    },
    { name: 'allowChildJobs', label: text.jobAllowChildJobs, type: 'checkbox' },
  ];
  const limitFields: FormField[] = [
    {
      name: 'concurrency',
      label: text.hookConcurrency,
      type: 'select',
      options: HOOK_CONCURRENCY_MODES.map((item) => ({ value: item, label: hookConcurrencyLabels[item] })),
    },
    {
      name: 'maxStartsPerHour',
      label: text.hookMaxStartsPerHour,
      type: 'number',
      required: true,
      min: 1,
      max: MAX_HOOK_MAX_STARTS_PER_HOUR,
    },
  ];
  return (
    <>
      <FormFields fields={triggerFields} values={values} onChange={onChange} />
      {filterFields.length > 0 && (
        <>
          <h3 className="form-section-heading">{text.hookFilter}</h3>
          <p className="muted">{text.hookFilterHint}</p>
          <FormFields fields={filterFormFields} values={values} onChange={onChange} />
        </>
      )}
      <h3 className="form-section-heading">{text.hookTemplate}</h3>
      {usesRegisteredModelVersion(trigger) && <p className="muted">{text.hookRegisteredModelVersion}</p>}
      <FormFields fields={templateFields} values={values} onChange={onChange} />
      {isSite && target?.submissionMode === 'manual' && (
        <p className="notice">{text.hookManualSiteNotice}</p>
      )}
      {code && <CodeRuntimeDetails version={code} />}
      {code && !compatibleTargets.length && <p className="notice">{text.noCompatibleTargets}</p>}
      <h3 className="form-section-heading">{text.hookLimits}</h3>
      <FormFields fields={limitFields} values={values} onChange={onChange} />
      <p className="muted">{text.hookFixedSettings}</p>
    </>
  );
}
