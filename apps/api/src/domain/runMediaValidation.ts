import {
  MEDIA_COMPARE_MAX_RUNS,
  MEDIA_COMPARE_MAX_STEPS,
  MEDIA_TABLE_PAGE_MAX_ROWS,
  RUN_MEDIA_CAPTION_MAX_LENGTH,
  RUN_MEDIA_CREATE_MAX_ITEMS,
  RUN_MEDIA_KEY_MAX_LENGTH,
  RUN_MEDIA_METADATA_MAX_BYTES,
} from '@mmt/contracts';
import { z } from 'zod';
import { jsonObjectSchema, uuidSchema } from './validation.js';

// A page of media is a slider's worth of steps; the table page limit is in the contract.
const DEFAULT_MEDIA_PAGE_LIMIT = 100;
const MAX_MEDIA_PAGE_LIMIT = 500;
const DEFAULT_TABLE_PAGE_LIMIT = 50;

export const runMediaKindSchema = z.enum(['audio', 'image', 'video', 'table']);
const stepSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const queryStepSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Keys are shown as labels and used as filters, so control characters are refused.
export const runMediaKeySchema = z
  .string()
  .min(1)
  .max(RUN_MEDIA_KEY_MAX_LENGTH)
  .refine((key) => !/[\u0000-\u001f\u007f]/.test(key), 'Control characters are not allowed');

const runMediaCreateItemSchema = z.strictObject({
  id: uuidSchema.transform((id) => id.toLowerCase()).optional(),
  key: runMediaKeySchema,
  step: stepSchema,
  kind: runMediaKindSchema,
  artifactId: uuidSchema.transform((id) => id.toLowerCase()),
  caption: z.string().max(RUN_MEDIA_CAPTION_MAX_LENGTH).nullable().default(null),
  metadata: jsonObjectSchema
    .refine(
      (metadata) => Buffer.byteLength(JSON.stringify(metadata)) <= RUN_MEDIA_METADATA_MAX_BYTES,
      'Media metadata is too large',
    )
    .default({}),
});
export type RunMediaCreateItemInput = z.infer<typeof runMediaCreateItemSchema>;

export const runMediaCreateSchema = z.strictObject({
  items: z.array(runMediaCreateItemSchema).min(1).max(RUN_MEDIA_CREATE_MAX_ITEMS),
});
export type RunMediaCreateInput = z.infer<typeof runMediaCreateSchema>;

export const runMediaListQuerySchema = z
  .strictObject({
    key: runMediaKeySchema.optional(),
    kind: runMediaKindSchema.optional(),
    stepFrom: queryStepSchema.optional(),
    stepTo: queryStepSchema.optional(),
    artifactId: uuidSchema.transform((id) => id.toLowerCase()).optional(),
    cursor: z.string().min(1).max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_MEDIA_PAGE_LIMIT).default(DEFAULT_MEDIA_PAGE_LIMIT),
  })
  .refine(
    (query) => query.stepFrom === undefined || query.stepTo === undefined || query.stepFrom <= query.stepTo,
    'stepFrom must not exceed stepTo',
  );
export type RunMediaListQuery = z.infer<typeof runMediaListQuerySchema>;

export const mediaCompareSchema = z.strictObject({
  runIds: z
    .array(uuidSchema.transform((id) => id.toLowerCase()))
    .min(1)
    .max(MEDIA_COMPARE_MAX_RUNS)
    .refine((ids) => new Set(ids).size === ids.length, 'Run IDs must be unique'),
  key: runMediaKeySchema,
  kind: runMediaKindSchema.optional(),
  steps: z
    .array(stepSchema)
    .min(1)
    .max(MEDIA_COMPARE_MAX_STEPS)
    .refine((steps) => new Set(steps).size === steps.length, 'Steps must be unique')
    .optional(),
});
export type MediaCompareInput = z.infer<typeof mediaCompareSchema>;

export const mediaTableQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(MEDIA_TABLE_PAGE_MAX_ROWS).default(DEFAULT_TABLE_PAGE_LIMIT),
});
export type MediaTableQuery = z.infer<typeof mediaTableQuerySchema>;

/** The MIME major type a media kind must not contradict; a generic type such as octet-stream passes. */
const KIND_MIME_MAJOR_TYPES: Record<string, string> = { audio: 'audio', image: 'image', video: 'video' };

/** false when the Artifact's MIME type names a different medium than the item's kind. */
export function isMediaKindCompatible(kind: string, mimeType: string): boolean {
  const major = mimeType.split('/')[0]!.trim().toLowerCase();
  const mediaMajorTypes = Object.values(KIND_MIME_MAJOR_TYPES);
  if (!mediaMajorTypes.includes(major)) return true;
  return KIND_MIME_MAJOR_TYPES[kind] === major;
}
