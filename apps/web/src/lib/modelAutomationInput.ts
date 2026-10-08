import type { CodeVersion, ModelAutomationRule } from '@mmt/contracts';
import type { CreateAutomationRule } from '../api/inputs';
import type {
  AutomationCatalog,
  AutomationKind,
  AutomationTrigger,
} from '../types/modelAutomation';
import type { FormValues } from '../types/form';
import { getFieldValue, getSelectedValues, parseJsonObject, parseStringMap } from './formValues';
import { DEFAULT_JOB_ATTEMPTS, parseMaxAttempts } from './executionValidation';
import { validateTargetGpuIds, validateTargetRuntime } from './runtimeValidation';
import { text } from '../i18n/catalog';
import { automationText } from '../i18n/automation';

export const AUTOMATION_KINDS: AutomationKind[] = ['inference', 'evaluation', 'processing'];
export const AUTOMATION_TRIGGERS: AutomationTrigger[] = [
  'model_registered',
  'upstream_run_finished',
];
// Mirrors RESERVED_RUN_TAG_PREFIXES in the API (domain/reservedRunTags.ts): the server sets these
// tags on automatic Runs, so a rule may not carry them.
const RESERVED_TAG_PREFIXES = ['automation.', 'mmt.'] as const;

/** Enabled rules of the Project that may start this rule; a rule never follows itself. */
export function upstreamRuleCandidates(
  rules: ModelAutomationRule[],
  currentRuleId?: string,
): ModelAutomationRule[] {
  return rules.filter((rule) => rule.enabled && rule.id !== currentRuleId);
}
export function isAutomationCodeCompatible({
  code,
  kind,
  modelFamilies,
}: {
  code: CodeVersion;
  kind: AutomationKind;
  modelFamilies: string[];
}): boolean {
  return (
    code.taskTypes.includes(kind) &&
    modelFamilies.every((family) => code.supportedModelFamilies.includes(family))
  );
}
export function createAutomationValues(modelFamilies: string[] = []): FormValues {
  return {
    name: '',
    enabled: 'true',
    trigger: 'model_registered',
    upstreamRuleId: '',
    modelFamilies,
    kind: 'inference',
    experimentId: '',
    codeVersionId: '',
    targetId: '',
    gpuIds: [],
    inputDatasetVersionIds: [],
    parameters: '{}',
    tags: '{}',
    maxAttempts: String(DEFAULT_JOB_ATTEMPTS),
  };
}
export function updateAutomationValues({
  previous,
  next,
  catalog,
}: {
  previous: FormValues;
  next: FormValues;
  catalog: AutomationCatalog;
}): FormValues {
  const updated = { ...next };
  if (getFieldValue(next, 'trigger') !== 'upstream_run_finished') updated.upstreamRuleId = '';
  const upstream = catalog.rules.find((rule) => rule.id === updated.upstreamRuleId);
  // A downstream stage normally runs on the same model families as its upstream stage.
  if (
    upstream &&
    updated.upstreamRuleId !== previous.upstreamRuleId &&
    !getSelectedValues(next, 'modelFamilies').length
  )
    updated.modelFamilies = upstream.modelFamilies;
  const code = catalog.registry.codeVersions.find((version) => version.id === next.codeVersionId);
  if (
    code &&
    !isAutomationCodeCompatible({
      code,
      kind: getFieldValue(next, 'kind') as AutomationKind,
      modelFamilies: getSelectedValues(next, 'modelFamilies'),
    })
  )
    updated.codeVersionId = '';
  if (updated.codeVersionId !== previous.codeVersionId) {
    updated.targetId = '';
    updated.gpuIds = [];
  }
  if (updated.targetId !== previous.targetId) updated.gpuIds = [];
  return updated;
}
function validateReferences(values: FormValues, catalog: AutomationCatalog) {
  const experimentId = getFieldValue(values, 'experimentId');
  const datasetIds = getSelectedValues(values, 'inputDatasetVersionIds');
  if (
    !catalog.registry.experiments.some((experiment) => experiment.id === experimentId) ||
    datasetIds.some((id) => !catalog.registry.datasetVersions.some((version) => version.id === id))
  )
    throw new Error(text.automationReferenceError);
}
function parseTrigger(values: FormValues, catalog: AutomationCatalog) {
  const trigger = getFieldValue(values, 'trigger') as AutomationTrigger;
  if (!AUTOMATION_TRIGGERS.includes(trigger)) throw new Error(automationText.triggerError);
  if (trigger === 'model_registered') return { trigger, upstreamRuleId: null };
  const upstreamRuleId = getFieldValue(values, 'upstreamRuleId');
  if (!upstreamRuleId) throw new Error(automationText.upstreamRequired);
  if (!upstreamRuleCandidates(catalog.rules).some((rule) => rule.id === upstreamRuleId))
    throw new Error(automationText.upstreamInvalid);
  return { trigger, upstreamRuleId };
}
function parseRuleTags(values: FormValues): Record<string, string> {
  const tags = parseStringMap(getFieldValue(values, 'tags'));
  const reserved = Object.keys(tags).find((key) =>
    RESERVED_TAG_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  if (reserved !== undefined) throw new Error(automationText.reservedTag(reserved));
  return tags;
}
export function buildAutomationRuleInput(
  values: FormValues,
  catalog: AutomationCatalog,
): CreateAutomationRule {
  const name = getFieldValue(values, 'name').trim();
  const modelFamilies = [...new Set(getSelectedValues(values, 'modelFamilies'))];
  const kind = getFieldValue(values, 'kind') as AutomationKind;
  if (!name) throw new Error(text.required);
  if (!modelFamilies.length) throw new Error(text.automationFamiliesError);
  const code = catalog.registry.codeVersions.find(
    (version) => version.id === getFieldValue(values, 'codeVersionId'),
  );
  if (
    !AUTOMATION_KINDS.includes(kind) ||
    !code ||
    !isAutomationCodeCompatible({ code, kind, modelFamilies })
  )
    throw new Error(text.automationCodeError);
  validateReferences(values, catalog);
  const { trigger, upstreamRuleId } = parseTrigger(values, catalog);
  const target = catalog.targets.find((item) => item.id === getFieldValue(values, 'targetId'));
  validateTargetRuntime(target, code);
  if (!target) throw new Error(text.runtimeTargetError);
  const gpuIds = getSelectedValues(values, 'gpuIds');
  validateTargetGpuIds(target, gpuIds);
  return {
    name,
    enabled: getFieldValue(values, 'enabled') === 'true',
    trigger,
    upstreamRuleId,
    modelFamilies,
    kind,
    experimentId: getFieldValue(values, 'experimentId'),
    codeVersionId: code.id,
    targetId: target.id,
    gpuIds,
    inputDatasetVersionIds: getSelectedValues(values, 'inputDatasetVersionIds'),
    parameters: parseJsonObject(getFieldValue(values, 'parameters')),
    tags: parseRuleTags(values),
    maxAttempts: parseMaxAttempts(getFieldValue(values, 'maxAttempts')),
  };
}
