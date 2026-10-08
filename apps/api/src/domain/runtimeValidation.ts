import { z } from 'zod';

export const runtimeKindSchema = z.enum(['python', 'docker', 'singularity', 'apptainer']);

function isContainerAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

// Keep path input bounded consistently with the existing target workDirectory limit.
const MAX_CONTAINER_WORKING_DIRECTORY_LENGTH = 4000;
const workingDirectorySchema = z
  .string()
  .min(1)
  .max(MAX_CONTAINER_WORKING_DIRECTORY_LENGTH)
  .refine(isContainerAbsolutePath, 'A container absolute path without traversal is required');

// Accept image references, including an optional registry/port and tag, without URL syntax.
const repositoryComponentPattern = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const registryHostPattern = '[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?';
const dockerImagePattern = new RegExp(
  `^(?:${registryHostPattern}/)?${repositoryComponentPattern}(?:/${repositoryComponentPattern})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$`,
);

// Match the existing Git source URL bound while rejecting non-reference URL syntax.
const MAX_DOCKER_REFERENCE_LENGTH = 2048;
export const executionRuntimeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('python') }),
  z.strictObject({
    kind: z.literal('docker'),
    image: z
      .string()
      .max(MAX_DOCKER_REFERENCE_LENGTH)
      .regex(dockerImagePattern, 'An image pinned to SHA256 is required'),
    workingDirectory: workingDirectorySchema.optional(),
  }),
  z.strictObject({
    kind: z.enum(['singularity', 'apptainer']),
    artifactId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, 'A SHA256 digest is required'),
    workingDirectory: workingDirectorySchema.optional(),
  }),
]);
