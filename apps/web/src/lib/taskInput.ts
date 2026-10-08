import type { CodeVersion, ComputeTarget, ExperimentTask, ExecutionMode, RunKind } from '@mmt/contracts';
import type { CreateTask, LaunchTask } from '../api/inputs';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { FormValues } from '../types/form';
import { getFieldValue, getSelectedValues, parseJsonObject, parseStringMap } from './formValues';
import { isCodeCompatible, RUN_KINDS } from './executionValidation';
import { validateTargetGpuIds, validateTargetRuntime } from './runtimeValidation';
import { text } from '../i18n/catalog';

export function createTaskValues(task?: ExperimentTask, experimentId = ''): FormValues {
  return {
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

export function buildTaskInput({ values, catalog, targets }: {
  values: FormValues; catalog: ExecutionCatalog; targets: ComputeTarget[];
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
  return updated;
}

export function getExecutionCommand(code: CodeVersion, mode: ExecutionMode) {
  return mode === 'test' ? code.testEntrypoint ?? [] : code.entrypoint;
}
