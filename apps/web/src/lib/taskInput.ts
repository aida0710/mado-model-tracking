import type {
  CodeVersion, ComputeTarget, ExperimentTask, ExecutionMode, Model, RunKind, TaskOutputModel,
} from '@mmt/contracts';
import type { CreateTask, LaunchTask } from '../api/inputs';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { FormValues } from '../types/form';
import { getFieldValue, getSelectedValues, parseJsonObject, parseStringMap } from './formValues';
import { isCodeCompatible, RUN_KINDS } from './executionValidation';
import { validateTargetGpuIds, validateTargetRuntime } from './runtimeValidation';
import { validateFilePath } from './codeWorkspace';
import { text } from '../i18n/catalog';

// Only these kinds produce weights, so only they may carry Task.outputModel.
export const OUTPUT_MODEL_KINDS: readonly RunKind[] = ['training', 'finetuning'];
// The conventional directory for weights, also used by the training code sample.
export const DEFAULT_OUTPUT_MODEL_ARTIFACT_PATH = 'model/';

export const hasOutputModel = (kind: RunKind) => OUTPUT_MODEL_KINDS.includes(kind);

function createOutputModelValues(outputModel: TaskOutputModel | null | undefined): FormValues {
  return {
    outputModelEnabled: String(!!outputModel),
    outputModelTarget: outputModel?.createModel ? 'create' : 'existing',
    outputModelId: outputModel?.modelId ?? '',
    outputModelName: outputModel?.createModel?.name ?? '',
    outputModelFamily: outputModel?.createModel?.family ?? '',
    outputModelArtifactPath: outputModel?.artifactPath ?? DEFAULT_OUTPUT_MODEL_ARTIFACT_PATH,
    outputModelDefaultCodeVersionId: outputModel?.defaultCodeVersionId ?? '',
  };
}

export function createTaskValues(task?: ExperimentTask, experimentId = ''): FormValues {
  return {
    ...createOutputModelValues(task?.outputModel),
    name: task?.name ?? '', description: task?.description ?? '',
    experimentId: task?.experimentId ?? experimentId, kind: task?.kind ?? 'inference',
    codeVersionId: task?.codeVersionId ?? '', modelVersionId: task?.modelVersionId ?? '',
    inputDatasetVersionIds: task?.inputDatasetVersionIds ?? [],
    parameters: JSON.stringify(task?.parameters ?? {}, null, 2),
    tags: JSON.stringify(task?.tags ?? {}, null, 2),
    targetId: task?.targetId ?? '', gpuIds: task?.gpuIds ?? [],
  };
}

function validateTaskVersions(input: CreateTask, catalog: ExecutionCatalog) {
  const model = catalog.modelVersions.find((version) => version.id === input.modelVersionId);
  const code = catalog.codeVersions.find((version) => version.id === input.codeVersionId);
  if (!catalog.experiments.some((experiment) => experiment.id === input.experimentId) ||
    (input.modelVersionId && !model) || input.inputDatasetVersionIds.some((id) =>
      !catalog.datasetVersions.some((version) => version.id === id)))
    throw new Error(text.taskReferenceError);
  if (!code || !isCodeCompatible(code, input.kind, model)) throw new Error(text.taskCodeError);
  return code;
}

/** Families the training code can emit; the registered version must be runnable by such code. */
export function getOutputModelFamilies(code: CodeVersion | undefined): string[] {
  return code?.supportedModelFamilies ?? [];
}

export function getOutputModelCandidates(models: Model[], code: CodeVersion | undefined): Model[] {
  const families = getOutputModelFamilies(code);
  return models.filter((model) => families.includes(model.family));
}

/** The family the registered version will have: the chosen Model's, or the new Model's. */
export function getOutputModelFamily(values: FormValues, models: Model[]): string {
  if (getFieldValue(values, 'outputModelTarget') === 'create') return getFieldValue(values, 'outputModelFamily');
  return models.find((model) => model.id === getFieldValue(values, 'outputModelId'))?.family ?? '';
}

export function getDefaultCodeCandidates(codeVersions: CodeVersion[], family: string): CodeVersion[] {
  return family ? codeVersions.filter((version) => version.supportedModelFamilies.includes(family)) : [];
}

function buildEnabledOutputModel({ values, catalog, code, previous }: {
  values: FormValues; catalog: ExecutionCatalog; code: CodeVersion | undefined;
  previous: TaskOutputModel | null | undefined;
}): TaskOutputModel {
  const families = getOutputModelFamilies(code);
  const isCreating = getFieldValue(values, 'outputModelTarget') === 'create';
  const modelId = getFieldValue(values, 'outputModelId');
  const name = getFieldValue(values, 'outputModelName').trim();
  const family = getOutputModelFamily(values, catalog.models);
  if (isCreating ? !name || !family : !catalog.models.some((model) => model.id === modelId))
    throw new Error(text.outputModelTargetError);
  if (!families.includes(family)) throw new Error(text.outputModelFamilyError);
  // The API checks the same relative-path rule as code files, which has no trailing slash, so
  // the directory `model/` is sent as `model`.
  const artifactPath = getFieldValue(values, 'outputModelArtifactPath').trim().replace(/\/$/, '');
  validateFilePath(artifactPath);
  const defaultCodeVersionId = getFieldValue(values, 'outputModelDefaultCodeVersionId') || null;
  if (defaultCodeVersionId && !getDefaultCodeCandidates(catalog.codeVersions, family)
    .some((version) => version.id === defaultCodeVersionId)) throw new Error(text.outputModelCodeError);
  return {
    // Fields without form controls are kept as saved so editing the Task does not drop them.
    ...(previous?.versionTemplate !== undefined && { versionTemplate: previous.versionTemplate }),
    ...(previous?.metadata !== undefined && { metadata: previous.metadata }),
    modelId: isCreating ? null : modelId,
    createModel: isCreating ? { name, family } : null,
    artifactPath, defaultCodeVersionId,
  };
}

/**
 * undefined means the field is not sent. Other kinds never send it, except null to clear a
 * setting saved before the kind changed, because PATCH keeps omitted fields.
 */
export function buildTaskOutputModel({ values, catalog, code, kind, previous }: {
  values: FormValues; catalog: ExecutionCatalog; code: CodeVersion | undefined; kind: RunKind;
  previous?: TaskOutputModel | null;
}): TaskOutputModel | null | undefined {
  if (!hasOutputModel(kind)) return previous ? null : undefined;
  if (getFieldValue(values, 'outputModelEnabled') !== 'true') return null;
  return buildEnabledOutputModel({ values, catalog, code, previous });
}

export function buildTaskInput({ values, catalog, targets, task }: {
  values: FormValues; catalog: ExecutionCatalog; targets: ComputeTarget[]; task?: ExperimentTask;
}): CreateTask {
  const kind = getFieldValue(values, 'kind') as RunKind;
  const input: CreateTask = {
    name: getFieldValue(values, 'name').trim(), description: getFieldValue(values, 'description'),
    experimentId: getFieldValue(values, 'experimentId'), kind,
    codeVersionId: getFieldValue(values, 'codeVersionId'), modelVersionId: getFieldValue(values, 'modelVersionId') || null,
    inputDatasetVersionIds: getSelectedValues(values, 'inputDatasetVersionIds'),
    parameters: parseJsonObject(getFieldValue(values, 'parameters')), tags: parseStringMap(getFieldValue(values, 'tags')),
    targetId: getFieldValue(values, 'targetId') || null, gpuIds: getSelectedValues(values, 'gpuIds'),
  };
  if (!input.name || !RUN_KINDS.includes(kind)) throw new Error(text.required);
  const code = validateTaskVersions(input, catalog);
  const outputModel = buildTaskOutputModel({ values, catalog, code, kind, previous: task?.outputModel });
  if (outputModel !== undefined) input.outputModel = outputModel;
  if (input.targetId) {
    const target = targets.find((item) => item.id === input.targetId);
    validateTargetRuntime(target, code);
    validateTargetGpuIds(target!, input.gpuIds);
  } else if (input.gpuIds.length) throw new Error(text.gpuSelectionError);
  return input;
}

export function buildTaskLaunchInput({ task, mode, values, catalog, targets }: {
  task: ExperimentTask; mode: ExecutionMode; values: FormValues;
  catalog: ExecutionCatalog; targets: ComputeTarget[];
}): LaunchTask {
  const launchDefaults = buildTaskInput({ values: {
    ...createTaskValues(task), ...values,
    codeVersionId: task.codeVersionId, experimentId: task.experimentId, kind: task.kind,
    // Launch copies the saved output setting on the API side and never sends it.
    outputModelEnabled: 'false',
  }, catalog, targets });
  if (!launchDefaults.targetId) throw new Error(text.runtimeTargetError);
  const code = catalog.codeVersions.find((version) => version.id === task.codeVersionId)!;
  if (mode === 'test' && !code.testEntrypoint?.length) throw new Error(text.testCommandRequired);
  return {
    expectedRevision: task.revision, executionMode: mode, targetId: launchDefaults.targetId,
    gpuIds: launchDefaults.gpuIds, name: launchDefaults.name,
    parameters: launchDefaults.parameters, modelVersionId: launchDefaults.modelVersionId,
    inputDatasetVersionIds: launchDefaults.inputDatasetVersionIds,
  };
}

export function updateTaskValues({ previous, next, catalog, targets }: {
  previous: FormValues; next: FormValues; catalog: ExecutionCatalog; targets: ComputeTarget[];
}): FormValues {
  const updated = { ...next };
  const model = catalog.modelVersions.find((item) => item.id === next.modelVersionId);
  const code = catalog.codeVersions.find((item) => item.id === next.codeVersionId);
  if ((next.kind !== previous.kind || next.modelVersionId !== previous.modelVersionId) &&
    code && !isCodeCompatible(code, getFieldValue(next, 'kind') as RunKind, model)) updated.codeVersionId = '';
  const selectedCode = catalog.codeVersions.find((item) => item.id === updated.codeVersionId);
  const target = targets.find((item) => item.id === next.targetId);
  if (selectedCode && target && !target.runtimeKinds.includes(selectedCode.runtime.kind)) updated.targetId = '';
  if (updated.targetId !== previous.targetId) updated.gpuIds = [];
  return clearUnsupportedOutputModel(updated, catalog, selectedCode);
}

// A code change can drop families, so selections the new code cannot run are cleared.
function clearUnsupportedOutputModel(values: FormValues, catalog: ExecutionCatalog, code: CodeVersion | undefined): FormValues {
  const updated = { ...values };
  const families = getOutputModelFamilies(code);
  if (!families.includes(getFieldValue(updated, 'outputModelFamily'))) updated.outputModelFamily = '';
  if (!getOutputModelCandidates(catalog.models, code).some((model) => model.id === updated.outputModelId))
    updated.outputModelId = '';
  const family = getOutputModelFamily(updated, catalog.models);
  if (!getDefaultCodeCandidates(catalog.codeVersions, family)
    .some((version) => version.id === updated.outputModelDefaultCodeVersionId)) updated.outputModelDefaultCodeVersionId = '';
  return updated;
}

export function getExecutionCommand(code: CodeVersion, mode: ExecutionMode) {
  return mode === 'test' ? code.testEntrypoint ?? [] : code.entrypoint;
}
