import {
  DEFAULT_HOOK_MAX_STARTS_PER_HOUR,
  HOOK_CHECKPOINT_MODES,
  HOOK_CONCURRENCY_MODES,
  HOOK_FILTER_FIELDS,
  HOOK_TRIGGERS,
  HOOK_WEBHOOK_SIGNATURES,
  MAX_HOOK_CHECKPOINT_EVERY,
  MAX_HOOK_MAX_STARTS_PER_HOUR,
  type CodeVersion,
  type HookCheckpointMode,
  type HookConcurrency,
  type HookCreate,
  type HookFilter,
  type HookJobTemplateInput,
  type HookTrigger,
  type HookWebhookSignature,
  type RunKind,
} from '@mmt/contracts';
import type { FormValues } from '../types/form';
import type { HookCatalog } from '../types/hooks';
import {
  getFieldValue,
  getSelectedValues,
  parseJsonObject,
  parsePositiveInteger,
  parseStringMap,
} from './formValues';
import { RUN_KINDS, parseMaxAttempts } from './executionValidation';
import { isTargetCompatible } from './runtimeValidation';
import { buildJobResources, isSiteTarget, parseArraySize } from './siteExecutionInput';
import { parseUserRunTags } from './reservedRunTags';
import { text } from '../i18n/catalog';
import { hooksTextTemplates } from '../i18n/hooks';

/** The model version select's value for "the triggering Run's version"; real values are uuids. */
export const INHERIT_MODEL_VERSION = 'inherit';
// Like automation rules, a hook retries only when more attempts are chosen.
const DEFAULT_HOOK_ATTEMPTS = 1;
export const HOOK_RUN_END_STATUSES = ['finished', 'failed', 'canceled'] as const;

export type HookFilterField = keyof HookFilter;

// The API refuses a condition the trigger's event cannot match, so only these are offered.

export const hookFilterFields = (trigger: HookTrigger): readonly HookFilterField[] =>
  HOOK_FILTER_FIELDS[trigger] ?? [];
/** These triggers come from a Run (an array's first member), whose model version a start may take. */
export const canInheritModelVersion = (trigger: HookTrigger): boolean =>
  trigger === 'run_finished' || trigger === 'array_finished' || trigger === 'checkpoint_saved';
/** These triggers follow finished Runs, whose output DatasetVersions a start may take as inputs. */
export const canInheritOutputDatasets = (trigger: HookTrigger): boolean =>
  trigger === 'run_finished' || trigger === 'array_finished';
/** A model_registered start always runs on the version that was registered. */
export const usesRegisteredModelVersion = (trigger: HookTrigger): boolean =>
  trigger === 'model_registered';

export function createHookValues(): FormValues {
  return {
    name: '',
    trigger: 'manual',
    filterModelFamilies: [],
    filterExperimentIds: [],
    filterRunKinds: [],
    filterRunStatuses: [],
    filterTags: '{}',
    experimentId: '',
    kind: 'inference',
    modelVersionId: '',
    codeVersionId: '',
    inputDatasetVersionIds: [],
    inheritOutputDatasets: 'false',
    targetId: '',
    gpuIds: [],
    gpuCount: '0',
    walltime: '',
    arraySize: '',
    datasetPartitionVersionId: '',
    parameters: '{}',
    tags: '{}',
    maxAttempts: String(DEFAULT_HOOK_ATTEMPTS),
    retryOnFailure: 'false',
    retryOnTimeout: 'false',
    allowChildJobs: 'false',
    checkpointMode: 'every',
    checkpointEvery: '',
    concurrency: 'queue',
    maxStartsPerHour: String(DEFAULT_HOOK_MAX_STARTS_PER_HOUR),
    webhookSignature: 'github',
  };
}

const triggerOf = (values: FormValues) => getFieldValue(values, 'trigger') as HookTrigger;

/** Model families of the Project: those of its models and those its code versions support. */
export function hookModelFamilies(catalog: HookCatalog): string[] {
  const { models, codeVersions } = catalog.registry;
  return [
    ...new Set([
      ...models.map((model) => model.family),
      ...codeVersions.flatMap((version) => version.supportedModelFamilies),
    ]),
  ].sort();
}

/**
 * The families the code must run: a fixed model version's, or the filtered families when the
 * version comes from the event (registered or inherited). No family is known without a filter.
 */
function requiredFamilies(values: FormValues, catalog: HookCatalog): string[] {
  const modelVersionId = getFieldValue(values, 'modelVersionId');
  const trigger = triggerOf(values);
  const eventFamilies = hookFilterFields(trigger).includes('modelFamilies')
    ? getSelectedValues(values, 'filterModelFamilies')
    : [];
  if (usesRegisteredModelVersion(trigger) || modelVersionId === INHERIT_MODEL_VERSION)
    return eventFamilies;
  const fixed = catalog.registry.modelVersions.find((version) => version.id === modelVersionId);
  return fixed ? [fixed.family] : [];
}

export function isHookCodeCompatible(code: CodeVersion, values: FormValues, catalog: HookCatalog) {
  const kind = getFieldValue(values, 'kind') as RunKind;
  return (
    code.taskTypes.includes(kind) &&
    requiredFamilies(values, catalog).every((family) => code.supportedModelFamilies.includes(family))
  );
}

/** Input versions an array may split among its members: selected inputs that hold files. */
export function partitionCandidates(values: FormValues, catalog: HookCatalog) {
  const inputs = getSelectedValues(values, 'inputDatasetVersionIds');
  return catalog.registry.datasetVersions.filter(
    (version) => inputs.includes(version.id) && version.contentKind === 'artifacts',
  );
}

/** Clears selections a change made impossible, as the automation rule form does. */
export function updateHookValues({
  previous,
  next,
  catalog,
}: {
  previous: FormValues;
  next: FormValues;
  catalog: HookCatalog;
}): FormValues {
  const updated = { ...next };
  const trigger = triggerOf(next);
  if (getFieldValue(next, 'modelVersionId') === INHERIT_MODEL_VERSION && !canInheritModelVersion(trigger))
    updated.modelVersionId = '';
  if (!canInheritOutputDatasets(trigger)) updated.inheritOutputDatasets = 'false';
  const code = catalog.registry.codeVersions.find((version) => version.id === next.codeVersionId);
  if (code && !isHookCodeCompatible(code, updated, catalog)) updated.codeVersionId = '';
  if (updated.codeVersionId !== previous.codeVersionId) {
    updated.targetId = '';
    updated.gpuIds = [];
  }
  if (updated.targetId !== previous.targetId) updated.gpuIds = [];
  const partitionId = getFieldValue(updated, 'datasetPartitionVersionId');
  if (
    partitionId &&
    (!getFieldValue(updated, 'arraySize').trim() ||
      !partitionCandidates(updated, catalog).some((version) => version.id === partitionId))
  )
    updated.datasetPartitionVersionId = '';
  return updated;
}

function parseChoice<T extends string>(value: string, choices: readonly T[], message: string): T {
  if (!choices.includes(value as T)) throw new Error(message);
  return value as T;
}

function buildFilter(values: FormValues, trigger: HookTrigger): HookFilter {
  const fields = hookFilterFields(trigger);
  const filter: HookFilter = {};
  const selected = (name: string) => [...new Set(getSelectedValues(values, name))];
  if (fields.includes('modelFamilies') && selected('filterModelFamilies').length)
    filter.modelFamilies = selected('filterModelFamilies');
  if (fields.includes('experimentIds') && selected('filterExperimentIds').length)
    filter.experimentIds = selected('filterExperimentIds');
  if (fields.includes('runKinds') && selected('filterRunKinds').length)
    filter.runKinds = selected('filterRunKinds') as RunKind[];
  if (fields.includes('runStatuses') && selected('filterRunStatuses').length)
    filter.runStatuses = selected('filterRunStatuses') as HookFilter['runStatuses'];
  if (fields.includes('tags')) {
    // A filter only reads tags, so the server's own tags may be matched as well.
    const tags = parseStringMap(getFieldValue(values, 'filterTags'));
    if (Object.keys(tags).length) filter.tags = tags;
  }
  return filter;
}

function validateReferences(values: FormValues, catalog: HookCatalog) {
  const { experiments, modelVersions, datasetVersions } = catalog.registry;
  const modelVersionId = getFieldValue(values, 'modelVersionId');
  if (
    !experiments.some((experiment) => experiment.id === getFieldValue(values, 'experimentId')) ||
    (modelVersionId &&
      modelVersionId !== INHERIT_MODEL_VERSION &&
      !modelVersions.some((version) => version.id === modelVersionId)) ||
    getSelectedValues(values, 'inputDatasetVersionIds').some(
      (id) => !datasetVersions.some((version) => version.id === id),
    )
  )
    throw new Error(text.hookReferenceError);
}

const isChecked = (values: FormValues, name: string) => getFieldValue(values, name) === 'true';

/** The site-only parts of a template: an array, the version it splits, and automatic retries. */
function buildSiteTemplate(values: FormValues, catalog: HookCatalog): Partial<HookJobTemplateInput> {
  const arraySize = parseArraySize(getFieldValue(values, 'arraySize'));
  const partitionId = getFieldValue(values, 'datasetPartitionVersionId') || null;
  if (
    partitionId &&
    (arraySize === null ||
      !partitionCandidates(values, catalog).some((version) => version.id === partitionId))
  )
    throw new Error(text.hookPartitionError);
  return {
    ...(arraySize !== null && { arraySize }),
    ...(partitionId && { datasetPartitionVersionId: partitionId }),
    ...(isChecked(values, 'retryOnFailure') && { retryOnFailure: true }),
    ...(isChecked(values, 'retryOnTimeout') && { retryOnTimeout: true }),
  };
}

function buildTemplate(values: FormValues, catalog: HookCatalog): HookJobTemplateInput {
  const trigger = triggerOf(values);
  const kind = getFieldValue(values, 'kind') as RunKind;
  validateReferences(values, catalog);
  const code = catalog.registry.codeVersions.find(
    (version) => version.id === getFieldValue(values, 'codeVersionId'),
  );
  if (!RUN_KINDS.includes(kind) || !code || !isHookCodeCompatible(code, values, catalog))
    throw new Error(text.hookCodeError);
  const target = catalog.targets.find((item) => item.id === getFieldValue(values, 'targetId'));
  if (!target || !isTargetCompatible(target, code)) throw new Error(text.hookTargetError);
  const modelVersionId = getFieldValue(values, 'modelVersionId');
  const inheritModelVersion =
    canInheritModelVersion(trigger) && modelVersionId === INHERIT_MODEL_VERSION;
  const fixedModelVersionId =
    usesRegisteredModelVersion(trigger) || inheritModelVersion ? null : modelVersionId || null;
  return {
    experimentId: getFieldValue(values, 'experimentId'),
    kind,
    codeVersionId: code.id,
    modelVersionId: fixedModelVersionId,
    inheritModelVersion,
    inputDatasetVersionIds: getSelectedValues(values, 'inputDatasetVersionIds'),
    inheritOutputDatasets:
      canInheritOutputDatasets(trigger) && isChecked(values, 'inheritOutputDatasets'),
    parameters: parseJsonObject(getFieldValue(values, 'parameters')),
    tags: parseUserRunTags(getFieldValue(values, 'tags')),
    targetId: target.id,
    ...buildJobResources(target, values),
    ...(isSiteTarget(target) && buildSiteTemplate(values, catalog)),
    maxAttempts: parseMaxAttempts(getFieldValue(values, 'maxAttempts')),
    allowChildJobs: isChecked(values, 'allowChildJobs'),
  };
}

function parseBoundedInteger(value: string, max: number, message: string): number {
  const number = parsePositiveInteger(value);
  if (number > max) throw new Error(message);
  return number;
}

/** How a hook starts: the checkpoint rule, overlap, rate limit and the webhook's signature. */
function buildStartRules(values: FormValues, trigger: HookTrigger): Omit<HookCreate, 'name' | 'trigger' | 'filter' | 'template'> {
  const rules: Omit<HookCreate, 'name' | 'trigger' | 'filter' | 'template'> = {
    concurrency: parseChoice<HookConcurrency>(
      getFieldValue(values, 'concurrency'),
      HOOK_CONCURRENCY_MODES,
      text.required,
    ),
    maxStartsPerHour: parseBoundedInteger(
      getFieldValue(values, 'maxStartsPerHour'),
      MAX_HOOK_MAX_STARTS_PER_HOUR,
      hooksTextTemplates.hookMaxStartsError(MAX_HOOK_MAX_STARTS_PER_HOUR),
    ),
  };
  if (trigger === 'checkpoint_saved') {
    const mode = parseChoice<HookCheckpointMode>(
      getFieldValue(values, 'checkpointMode'),
      HOOK_CHECKPOINT_MODES,
      text.required,
    );
    rules.checkpointMode = mode;
    if (mode === 'every_k')
      rules.checkpointEvery = parseBoundedInteger(
        getFieldValue(values, 'checkpointEvery'),
        MAX_HOOK_CHECKPOINT_EVERY,
        hooksTextTemplates.hookCheckpointEveryError(MAX_HOOK_CHECKPOINT_EVERY),
      );
  }
  if (trigger === 'webhook')
    rules.webhookSignature = parseChoice<HookWebhookSignature>(
      getFieldValue(values, 'webhookSignature'),
      HOOK_WEBHOOK_SIGNATURES,
      text.hookSignatureError,
    );
  return rules;
}

/** The create request of the hook form; only the fields of the chosen trigger and target are sent. */
export function buildHookInput(values: FormValues, catalog: HookCatalog): HookCreate {
  const name = getFieldValue(values, 'name').trim();
  if (!name) throw new Error(text.hookNameError);
  const trigger = parseChoice(getFieldValue(values, 'trigger'), HOOK_TRIGGERS, text.hookTriggerError);
  return {
    name,
    trigger,
    filter: buildFilter(values, trigger),
    template: buildTemplate(values, catalog),
    ...buildStartRules(values, trigger),
  };
}
