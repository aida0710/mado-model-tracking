import type { Artifact, CodeVersion, ComputeTarget, ExecutionRuntimeKind } from '@mmt/contracts';
import { text } from '../i18n/catalog';

export const EXECUTION_RUNTIME_KINDS: ExecutionRuntimeKind[] = [
  'python',
  'docker',
  'singularity',
  'apptainer',
];

// SHA256 values refer to the stored bytes, not an image tag or filename.
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DOCKER_REPOSITORY_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const DOCKER_REGISTRY_HOST = '[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?';
const DOCKER_IMAGE_PATTERN = new RegExp(
  `^(?:${DOCKER_REGISTRY_HOST}/)?${DOCKER_REPOSITORY_COMPONENT}(?:/${DOCKER_REPOSITORY_COMPONENT})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$`,
);
// Keep input validation aligned with the API limits for stored runtime references.
const MAX_DOCKER_IMAGE_LENGTH = 2048;
const MAX_CONTAINER_DIRECTORY_LENGTH = 4000;

export function isSifArtifact(artifact: Artifact): boolean {
  return artifact.path.toLowerCase().endsWith('.sif') && SHA256_PATTERN.test(artifact.sha256);
}

export function validateDockerImage(image: string) {
  if (image.length > MAX_DOCKER_IMAGE_LENGTH || !DOCKER_IMAGE_PATTERN.test(image))
    throw new Error(text.dockerImageError);
}

export function validateContainerWorkingDirectory(workingDirectory: string) {
  if (
    workingDirectory &&
    (!workingDirectory.startsWith('/') ||
      /[\\\u0000-\u001f\u007f]/.test(workingDirectory) ||
      workingDirectory.length > MAX_CONTAINER_DIRECTORY_LENGTH ||
      workingDirectory.split('/').some((part) => part === '.' || part === '..'))
  )
    throw new Error(text.containerDirectoryError);
}

export function parseRuntimeKinds(values: string[]): ExecutionRuntimeKind[] {
  if (
    !values.length ||
    values.some((value) => !EXECUTION_RUNTIME_KINDS.includes(value as ExecutionRuntimeKind))
  )
    throw new Error(text.runtimeKindsError);
  return [...new Set(values)] as ExecutionRuntimeKind[];
}

export function isTargetCompatible(target: ComputeTarget, code: CodeVersion): boolean {
  return target.enabled && target.runtimeKinds.includes(code.runtime.kind);
}

export function validateTargetRuntime(
  target: ComputeTarget | undefined,
  code: CodeVersion | undefined,
) {
  if (!target || !code || !isTargetCompatible(target, code))
    throw new Error(text.runtimeTargetError);
}

export function validateTargetGpuIds(target: ComputeTarget, gpuIds: string[]) {
  if (gpuIds.some((id) => !target.gpuIds.includes(id))) throw new Error(text.gpuSelectionError);
}
