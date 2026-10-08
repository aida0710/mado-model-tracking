import { z } from 'zod';
import type {
  MediaCompareGrid,
  MediaTableMediaCell,
  MediaTablePage,
  RunMedia,
  RunMediaKeySummary,
  RunMediaList,
  RunMediaPage,
} from '../runMedia.js';
import { artifactMediaInfoSchema } from './artifactMediaInfo.js';
import { idSchema, itemsOf, jsonObjectSchema, jsonValueSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

const runMediaKindSchema = z.enum(['audio', 'image', 'video', 'table']);

export const runMediaSchema = namedContractSchema(
  'RunMedia',
  z.strictObject({
    id: idSchema,
    runId: idSchema,
    key: z.string(),
    step: z.number().int(),
    kind: runMediaKindSchema,
    artifactId: idSchema,
    thumbnailArtifactId: idSchema.nullable(),
    caption: z.string().nullable(),
    metadata: jsonObjectSchema,
    source: z.enum(['native', 'mlflow']),
    path: z.string(),
    mimeType: z.string(),
    size: z.number().int(),
    contentUrl: z.string(),
    thumbnailContentUrl: z.string().nullable(),
    mediaInfo: artifactMediaInfoSchema.optional(),
    createdAt: timestampSchema,
  }),
);
export const runMediaListSchema = namedContractSchema('RunMediaList', itemsOf(runMediaSchema));
export const runMediaPageSchema = namedContractSchema(
  'RunMediaPage',
  z.strictObject({ items: z.array(runMediaSchema), nextCursor: z.string().optional() }),
);
export const runMediaKeySummarySchema = namedContractSchema(
  'RunMediaKeySummary',
  z.strictObject({
    key: z.string(),
    kind: runMediaKindSchema,
    count: z.number().int(),
    minStep: z.number().int(),
    maxStep: z.number().int(),
  }),
);
export const mediaCompareGridSchema = namedContractSchema(
  'MediaCompareGrid',
  z.strictObject({
    key: z.string(),
    steps: z.array(z.number().int()).nullable(),
    rows: z.array(
      z.strictObject({
        runId: idSchema,
        cells: z.array(z.array(runMediaSchema).nullable()),
      }),
    ),
  }),
);
export const mediaTableMediaCellSchema = namedContractSchema(
  'MediaTableMediaCell',
  z.strictObject({
    type: z.enum(['audio', 'image', 'video']),
    runId: idSchema.nullable(),
    path: z.string().nullable(),
    artifactId: idSchema.nullable(),
    thumbnailArtifactId: idSchema.nullable(),
    error: z
      .enum([
        'empty',
        'absolute_path',
        'parent_path',
        'unsupported_scheme',
        'invalid_run_reference',
        'other_project',
        'not_found',
      ])
      .nullable(),
  }),
);
export const mediaTablePageSchema = namedContractSchema(
  'MediaTablePage',
  z.strictObject({
    columns: z.array(
      z.strictObject({
        name: z.string(),
        type: z.enum(['text', 'number', 'audio', 'image', 'video', 'json']),
      }),
    ),
    rows: z.array(z.array(z.union([mediaTableMediaCellSchema, jsonValueSchema]))),
    totalRows: z.number().int(),
    offset: z.number().int(),
  }),
);

type _RunMedia = Expect<MutuallyAssignable<z.infer<typeof runMediaSchema>, RunMedia>>;
type _RunMediaList = Expect<MutuallyAssignable<z.infer<typeof runMediaListSchema>, RunMediaList>>;
type _RunMediaPage = Expect<MutuallyAssignable<z.infer<typeof runMediaPageSchema>, RunMediaPage>>;
type _RunMediaKeySummary = Expect<
  MutuallyAssignable<z.infer<typeof runMediaKeySummarySchema>, RunMediaKeySummary>
>;
type _MediaCompareGrid = Expect<
  MutuallyAssignable<z.infer<typeof mediaCompareGridSchema>, MediaCompareGrid>
>;
type _MediaTableMediaCell = Expect<
  MutuallyAssignable<z.infer<typeof mediaTableMediaCellSchema>, MediaTableMediaCell>
>;
type _MediaTablePage = Expect<
  MutuallyAssignable<z.infer<typeof mediaTablePageSchema>, MediaTablePage>
>;
