import { z } from 'zod';
import type { SavedView, SavedViewColumn, SavedViewState } from '../savedViews.js';
import { chartPanelLayoutSchema, runGroupBySchema } from './chartPanels.js';
import { idSchema, runKindSchema, runStatusSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const savedViewColumnSchema = namedContractSchema(
  'SavedViewColumn',
  z.strictObject({ key: z.string(), width: z.number().optional() }),
);
export const savedViewStateSchema = namedContractSchema(
  'SavedViewState',
  z.strictObject({
    version: z.literal(1),
    experimentIds: z.array(idSchema),
    filter: z.string(),
    orderBy: z.array(z.string()),
    statuses: z.array(runStatusSchema),
    kinds: z.array(runKindSchema),
    columns: z.array(savedViewColumnSchema),
    groupBy: runGroupBySchema.optional(),
    chartPanels: chartPanelLayoutSchema,
  }),
);
export const savedViewSchema = namedContractSchema(
  'SavedView',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    ownerUserId: idSchema,
    visibility: z.enum(['private', 'project']),
    page: z.literal('runs'),
    name: z.string(),
    state: savedViewStateSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
);

type _SavedViewColumn = Expect<
  MutuallyAssignable<z.infer<typeof savedViewColumnSchema>, SavedViewColumn>
>;
type _SavedViewState = Expect<
  MutuallyAssignable<z.infer<typeof savedViewStateSchema>, SavedViewState>
>;
type _SavedView = Expect<MutuallyAssignable<z.infer<typeof savedViewSchema>, SavedView>>;
