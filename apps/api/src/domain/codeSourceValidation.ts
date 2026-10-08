import { z } from 'zod';
import { hasAncestorPathConflict } from './codePathConflicts.js';

// Registry JSON is limited to 4 MiB; leave space for commands and metadata.
export const MAX_CODE_TEXT_BYTES = 3 * 1024 * 1024;
// Bound individual editor files and the number of paths sent to workers.
export const MAX_CODE_FILE_BYTES = 2_000_000;
export const MAX_CODE_FILES = 1000;

export function isSafeCodePath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path
      .split('/')
      .every((part) => !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}

export const codeFilePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeCodePath, 'A safe relative code path outside .git is required');

export function isGitSourceUrl(value: string): boolean {
  if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
  if (/^git@[\w.-]+:[^\s\0]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      !!url.hostname &&
      !url.hostname.startsWith('-') &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ((url.protocol === 'https:' && !url.username) ||
        (url.protocol === 'ssh:' &&
          (!url.username || /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(url.username))))
    );
  } catch {
    return false;
  }
}

export const gitUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isGitSourceUrl, 'Use a Git HTTPS or SSH URL without credentials');
export const gitCommitSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i, 'A full immutable commit is required')
  .transform((commit) => commit.toLowerCase());

const codeFilesSchema = z
  .record(
    codeFilePathSchema,
    z
      .string()
      .max(MAX_CODE_FILE_BYTES)
      .refine((text) => Buffer.byteLength(text) <= MAX_CODE_FILE_BYTES),
  )
  .superRefine((files, context) => {
    const paths = Object.keys(files);
    if (paths.length > MAX_CODE_FILES)
      context.addIssue({ code: 'custom', message: 'Too many code files' });
    if (
      Object.values(files).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) >
      MAX_CODE_TEXT_BYTES
    )
      context.addIssue({ code: 'custom', message: 'Code text exceeds the total size limit' });
    if (hasAncestorPathConflict(paths))
      context.addIssue({ code: 'custom', message: 'A code file cannot also be a directory' });
  });

export const codeSourceSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('git'),
      url: gitUrlSchema,
      commit: gitCommitSchema,
      files: codeFilesSchema.optional(),
      deletedFiles: z.array(codeFilePathSchema).max(MAX_CODE_FILES).optional(),
    })
    .superRefine((source, context) => {
      const deleted = source.deletedFiles ?? [];
      if (new Set(deleted).size !== deleted.length)
        context.addIssue({
          code: 'custom',
          path: ['deletedFiles'],
          message: 'Deleted paths must be unique',
        });
      if (deleted.some((path) => Object.hasOwn(source.files ?? {}, path)))
        context.addIssue({
          code: 'custom',
          path: ['deletedFiles'],
          message: 'A path cannot be both edited and deleted',
        });
      if (hasAncestorPathConflict([...Object.keys(source.files ?? {}), ...deleted]))
        context.addIssue({
          code: 'custom',
          message: 'Code paths cannot contain ancestor conflicts',
        });
    }),
  z.strictObject({
    kind: z.literal('inline'),
    files: codeFilesSchema.refine((files) => Object.keys(files).length > 0),
  }),
  z.strictObject({ kind: z.literal('artifact'), artifactId: z.uuid() }),
]);

export const repositoryFilesSchema = z.strictObject({ url: gitUrlSchema, commit: gitCommitSchema });
export type RepositoryFilesRequest = z.infer<typeof repositoryFilesSchema>;
