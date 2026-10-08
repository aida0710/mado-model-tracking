import type { CodeVersion } from '@mmt/contracts';
import type { CreateAutomationRule } from '../api/inputs';
import type { AutomationCatalog, AutomationKind } from '../types/modelAutomation';
import type { FormValues } from '../types/form';
import { getFieldValue, getSelectedValues, parseJsonObject, parseStringMap } from './formValues';
import { DEFAULT_JOB_ATTEMPTS, parseMaxAttempts } from './executionValidation';
import { validateTargetGpuIds, validateTargetRuntime } from './runtimeValidation';
import { text } from '../i18n/catalog';

export const AUTOMATION_KINDS: AutomationKind[] = ['inference', 'evaluation'];
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
  const target = catalog.targets.find((item) => item.id === getFieldValue(values, 'targetId'));
  validateTargetRuntime(target, code);
  if (!target) throw new Error(text.runtimeTargetError);
  const gpuIds = getSelectedValues(values, 'gpuIds');
  validateTargetGpuIds(target, gpuIds);
  return {
    name,
    enabled: getFieldValue(values, 'enabled') === 'true',
    modelFamilies,
    kind,
    experimentId: getFieldValue(values, 'experimentId'),
    codeVersionId: code.id,
    targetId: target.id,
    gpuIds,
    inputDatasetVersionIds: getSelectedValues(values, 'inputDatasetVersionIds'),
    parameters: parseJsonObject(getFieldValue(values, 'parameters')),
    tags: parseStringMap(getFieldValue(values, 'tags')),
    maxAttempts: parseMaxAttempts(getFieldValue(values, 'maxAttempts')),
  };
}
