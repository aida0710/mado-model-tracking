import { z } from 'zod';
import { MAX_DATASET_VERSION_FILES } from '@mmt/contracts';
import {
  externalDatasetRefSchema,
  isRelativeFilePath,
  jsonObjectSchema,
  nameSchema,
  uniqueIdsSchema,
  uuidSchema,
} from './validation.js';

// Same bound as stored Artifact paths (artifactRegistration), so any Artifact path fits.
const MAX_DATASET_FILE_PATH_LENGTH = 1024;
// Cursors are base64url JSON holding one path, so they stay below a few kilobytes.
const MAX_CURSOR_LENGTH = 4096;
// A page of the file list; the Web tree shows one directory level per page.
const DEFAULT_FILE_PAGE_LIMIT = 1000;
const MAX_FILE_PAGE_LIMIT = 1000;
// Control characters make paths unsafe to write on the worker host and to show in the UI.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function isDatasetFilePath(path: string): boolean {
  return (
    path.length <= MAX_DATASET_FILE_PATH_LENGTH &&
    isRelativeFilePath(path) &&
    !CONTROL_CHARACTER_PATTERN.test(path)
  );
}

const datasetFilePathSchema = z
  .string()
  .refine(isDatasetFilePath, 'A relative file path without `.`/`..` segments is required');

// A directory prefix: '' for the root, otherwise a safe relative path, with or without the `/`.
const directoryPrefixSchema = z
  .string()
  .max(MAX_DATASET_FILE_PATH_LENGTH)
  .refine((prefix) => prefix === '' || isDatasetFilePath(prefix.replace(/\/$/, '')), 'Invalid prefix')
  .default('');

const datasetFilesContentSchema = z.strictObject({
  kind: z.literal('artifacts'),
  files: z
    .array(z.strictObject({ path: datasetFilePathSchema, artifactId: uuidSchema }))
    .min(1)
    .max(MAX_DATASET_VERSION_FILES)
    .refine(
      (files) => new Set(files.map((file) => file.path)).size === files.length,
      'File paths must be unique',
    ),
});

const runArtifactsContentSchema = z.strictObject({
  kind: z.literal('artifacts'),
  fromRunArtifacts: z.strictObject({ runId: uuidSchema, prefix: directoryPrefixSchema }),
});

export const datasetVersionContentSchema = z.union([
  datasetFilesContentSchema,
  runArtifactsContentSchema,
]);
export type DatasetVersionContentInput = z.infer<typeof datasetVersionContentSchema>;

/**
 * POST /projects/:p/datasets/:d/versions. Without content the request registers a reference
 * version (version, uri and digest required). With content the server sets uri and computes the
 * digest; a digest sent anyway must match it, and version may be omitted to take the next integer.
 */
export const datasetVersionRequestSchema = z
  .strictObject({
    version: nameSchema.optional(),
    uri: z.string().min(1).max(4000).optional(),
    digest: z.string().min(1).max(1000).optional(),
    schema: jsonObjectSchema.default({}),
    metadata: jsonObjectSchema.default({}),
    sourceRunId: uuidSchema.nullish(),
    parentDatasetVersionIds: uniqueIdsSchema.default([]),
    externalRef: externalDatasetRefSchema.nullish(),
    content: datasetVersionContentSchema.optional(),
  })
  .superRefine((request, context) => {
    const required = request.content ? [] : (['version', 'uri', 'digest'] as const);
    for (const key of required)
      if (request[key] === undefined)
        context.addIssue({ code: 'custom', path: [key], message: `${key} is required` });
    // The server owns the uri of an Artifact version, and plugin imports are reference versions.
    const forbidden = request.content ? (['uri', 'externalRef'] as const) : [];
    for (const key of forbidden)
      if (request[key] != null)
        context.addIssue({ code: 'custom', path: [key], message: `${key} is set by the server` });
  });
export type DatasetVersionRequest = z.infer<typeof datasetVersionRequestSchema>;

export const datasetFileListQuerySchema = z.object({
  prefix: directoryPrefixSchema,
  delimiter: z.literal('/').optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_FILE_PAGE_LIMIT)
    .default(DEFAULT_FILE_PAGE_LIMIT),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});
export type DatasetFileListQuery = z.infer<typeof datasetFileListQuerySchema>;

export const datasetFileTreeQuerySchema = z.object({ prefix: directoryPrefixSchema });

// SHA-256 of the whole Artifact in lowercase hex, as artifacts.sha256 stores it.
export const artifactDigestQuerySchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.coerce.number().int().min(0),
});
