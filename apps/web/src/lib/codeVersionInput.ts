import type { Artifact, CodeSource, CodeVersion, ExecutionRuntime, RunKind } from '@mmt/contracts';
import type { CreateCodeVersion } from '../api/inputs';
import type { FormValues } from '../types/form';
import {
  getFieldValue,
  getSelectedValues,
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
import type { CodeWorkspace } from '../types/codeWorkspace';
import { buildWorkspaceSource, validateFilePaths, validateGitRepository } from './codeWorkspace';
import { parseCommand } from './commandInput';

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
    testEntrypoint: '',
    requirements: '',
    environment: '{}',
    families: '',
    taskTypes: [],
  };
}

export function createValuesFromCodeVersion(version?: CodeVersion): FormValues {
  if (!version) return createCodeVersionValues();
  const runtime = version.runtime;
  const source = version.source;
  return {
    ...createCodeVersionValues(),
    runtimeKind: runtime.kind,
    image: runtime.kind === 'docker' ? runtime.image : '',
    sifArtifactId: runtime.kind === 'singularity' || runtime.kind === 'apptainer' ? runtime.artifactId : '',
    sha256: runtime.kind === 'singularity' || runtime.kind === 'apptainer' ? runtime.sha256 : '',
    workingDirectory: runtime.kind !== 'python' ? runtime.workingDirectory ?? '' : '',
    sourceKind: source?.kind ?? 'none',
    url: source?.kind === 'git' ? source.url : '',
    commit: source?.kind === 'git' ? source.commit : '',
    files: JSON.stringify(source && (source.kind === 'inline' || source.kind === 'git') ? source.files ?? {} : {}, null, 2),
    sourceArtifactId: source?.kind === 'artifact' ? source.artifactId : '',
    entrypoint: JSON.stringify(version.entrypoint),
    testEntrypoint: version.testEntrypoint?.length ? JSON.stringify(version.testEntrypoint) : '',
    requirements: version.requirements.join('\n'),
    environment: JSON.stringify(version.environment, null, 2),
    families: version.supportedModelFamilies.join('\n'),
    taskTypes: [...version.taskTypes],
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

function buildSource(values: FormValues, workspace?: CodeWorkspace): CodeSource | null {
  const kind = getFieldValue(values, 'sourceKind');
  if (kind === 'none') return null;
  if (kind === 'git') {
    const url = getFieldValue(values, 'url').trim();
    const commit = getFieldValue(values, 'commit').trim();
    if (!url || !commit) throw new Error(text.required);
    if (workspace) return buildWorkspaceSource({ url, commit }, workspace);
    validateGitRepository({ url, commit });
    return { kind, url, commit };
  }
  if (kind === 'inline') {
    const files = workspace?.files ?? parseStringMap(getFieldValue(values, 'files'));
    if (!Object.keys(files).length) throw new Error(text.noFiles);
    validateFilePaths(Object.keys(files));
    return { kind, files };
  }
  if (kind !== 'artifact' || !getFieldValue(values, 'sourceArtifactId'))
    throw new Error(text.required);
  return { kind, artifactId: getFieldValue(values, 'sourceArtifactId') };
}

export function buildCodeVersionInput({
  values,
  artifacts,
  projectId,
  workspace,
}: {
  values: FormValues;
  artifacts: Artifact[];
  projectId: string;
  workspace?: CodeWorkspace;
}): CreateCodeVersion {
  const projectArtifacts = artifacts.filter((artifact) => artifact.projectId === projectId);
  const runtime = buildRuntime(values, projectArtifacts);
  const source = buildSource(values, workspace);
  if (
    source?.kind === 'artifact' &&
    !projectArtifacts.some((artifact) => artifact.id === source.artifactId)
  )
    throw new Error(text.sourceArtifactError);
  if (runtime.kind === 'python' && !source) throw new Error(text.pythonSourceError);
  const version = getFieldValue(values, 'version').trim();
  const entrypoint = parseCommand(getFieldValue(values, 'entrypoint'));
  const testEntrypoint = parseCommand(getFieldValue(values, 'testEntrypoint'), { optional: true });
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
    testEntrypoint,
    requirements:
      runtime.kind === 'python' ? splitLines(getFieldValue(values, 'requirements')) : [],
    environment: parseStringMap(getFieldValue(values, 'environment')),
    supportedModelFamilies,
    taskTypes: taskTypes as RunKind[],
  };
}
