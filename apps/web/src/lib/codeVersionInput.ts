import type { Artifact, CodeSource, ExecutionRuntime, RunKind } from '@mmt/contracts';
import type { CreateCodeVersion } from '../api/inputs';
import type { FormValues } from '../types/form';
import {
  getFieldValue,
  getSelectedValues,
  parseStringArray,
  parseStringMap,
  splitLines,
} from './formValues';
import { RUN_KINDS } from './executionValidation';
import {
  isSifArtifact,
  validateContainerWorkingDirectory,
  validateDockerImage,
} from './runtimeValidation';
import { text } from '../i18n/catalog';

export function createCodeVersionValues(): FormValues {
  return {
    version: '',
    runtimeKind: 'python',
    image: '',
    sifArtifactId: '',
    sha256: '',
    workingDirectory: '',
    artifactSearch: '',
    sourceKind: 'git',
    url: '',
    commit: '',
    files: '{}',
    sourceArtifactId: '',
    entrypoint: '',
    requirements: '',
    environment: '{}',
    families: '',
    taskTypes: [],
  };
}

export function updateCodeVersionValues({
  previous,
  next,
  artifacts,
}: {
  previous: FormValues;
  next: FormValues;
  artifacts: Artifact[];
}): FormValues {
  const updated = { ...next };
  if (next.runtimeKind !== previous.runtimeKind) {
    if (next.runtimeKind === 'python' && next.sourceKind === 'none') updated.sourceKind = 'git';
    if (previous.runtimeKind === 'python' && next.runtimeKind !== 'python')
      updated.sourceKind = 'none';
  }
  if (next.sifArtifactId !== previous.sifArtifactId)
    updated.sha256 = artifacts.find((artifact) => artifact.id === next.sifArtifactId)?.sha256 ?? '';
  return updated;
}

function buildRuntime(values: FormValues, artifacts: Artifact[]): ExecutionRuntime {
  const kind = getFieldValue(values, 'runtimeKind');
  if (kind === 'python') return { kind };
  const workingDirectory = getFieldValue(values, 'workingDirectory').trim();
  validateContainerWorkingDirectory(workingDirectory);
  const directory = workingDirectory ? { workingDirectory } : {};
  if (kind === 'docker') {
    const image = getFieldValue(values, 'image').trim();
    validateDockerImage(image);
    return { kind, image, ...directory };
  }
  if (kind !== 'singularity' && kind !== 'apptainer') throw new Error(text.runtimeKindsError);
  const artifactId = getFieldValue(values, 'sifArtifactId');
  const artifact = artifacts.find((item) => item.id === artifactId);
  if (!artifact || !isSifArtifact(artifact) || artifact.sha256 !== getFieldValue(values, 'sha256'))
    throw new Error(text.sifArtifactError);
  return { kind, artifactId, sha256: artifact.sha256, ...directory };
}

function buildSource(values: FormValues): CodeSource | null {
  const kind = getFieldValue(values, 'sourceKind');
  if (kind === 'none') return null;
  if (kind === 'git') {
    const url = getFieldValue(values, 'url').trim();
    const commit = getFieldValue(values, 'commit').trim();
    if (!url || !commit) throw new Error(text.required);
    return { kind, url, commit };
  }
  if (kind === 'inline') return { kind, files: parseStringMap(getFieldValue(values, 'files')) };
  if (kind !== 'artifact' || !getFieldValue(values, 'sourceArtifactId'))
    throw new Error(text.required);
  return { kind, artifactId: getFieldValue(values, 'sourceArtifactId') };
}

export function buildCodeVersionInput({
  values,
  artifacts,
  projectId,
}: {
  values: FormValues;
  artifacts: Artifact[];
  projectId: string;
}): CreateCodeVersion {
  const projectArtifacts = artifacts.filter((artifact) => artifact.projectId === projectId);
  const runtime = buildRuntime(values, projectArtifacts);
  const source = buildSource(values);
  if (
    source?.kind === 'artifact' &&
    !projectArtifacts.some((artifact) => artifact.id === source.artifactId)
  )
    throw new Error(text.sourceArtifactError);
  if (runtime.kind === 'python' && !source) throw new Error(text.pythonSourceError);
  const version = getFieldValue(values, 'version').trim();
  const entrypoint = parseStringArray(getFieldValue(values, 'entrypoint'));
  if (!entrypoint[0]?.trim() || entrypoint.some((argument) => argument.includes('\0')))
    throw new Error(text.emptyCommandError);
  const supportedModelFamilies = splitLines(getFieldValue(values, 'families'));
  const taskTypes = getSelectedValues(values, 'taskTypes');
  if (!version || !supportedModelFamilies.length || !taskTypes.length)
    throw new Error(text.required);
  if (taskTypes.some((kind) => !RUN_KINDS.includes(kind as RunKind)))
    throw new Error(text.required);
  return {
    version,
    runtime,
    source,
    entrypoint,
    requirements:
      runtime.kind === 'python' ? splitLines(getFieldValue(values, 'requirements')) : [],
    environment: parseStringMap(getFieldValue(values, 'environment')),
    supportedModelFamilies,
    taskTypes: taskTypes as RunKind[],
  };
}
