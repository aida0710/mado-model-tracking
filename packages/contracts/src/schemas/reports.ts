import { z } from 'zod';
import type {
  Report,
  ReportBlock,
  ReportBlockSnapshot,
  ReportDetail,
  ReportPage,
  ReportRevision,
  ReportRevisionSummary,
  ReportRunSet,
  ReportSnapshotList,
  ReportUser,
} from '../reports.js';
import { chartPanelConfigSchema } from './chartPanels.js';
import { metricGroupSchema, metricSeriesSchema } from './metricSeries.js';
import {
  cursorPageOf,
  idSchema,
  itemsOf,
  runKindSchema,
  runStatusSchema,
  timestampSchema,
} from './primitives.js';
import { parameterImportanceResultSchema, runAnalysisTableResponseSchema } from './runAnalysis.js';
import { mediaCompareGridSchema, mediaTablePageSchema } from './runMedia.js';
import { runSchema } from './runs.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

const embedModeSchema = z.enum(['live', 'snapshot']);

// RunSearchRequest without paging, as stored in a block (the API fills absent conditions).
const reportRunSearchSchema = z.strictObject({
  experimentIds: z.array(idSchema).optional(),
  filter: z.string().optional(),
  orderBy: z.array(z.string()).optional(),
  kinds: z.array(runKindSchema).optional(),
  statuses: z.array(runStatusSchema).optional(),
  modelVersionIds: z.array(idSchema).optional(),
  inputDatasetVersionIds: z.array(idSchema).optional(),
  parentRunId: idSchema.optional(),
  name: z.string().optional(),
});

export const reportRunSetSchema = namedContractSchema(
  'ReportRunSet',
  z.union([
    z.strictObject({ runIds: z.array(idSchema) }),
    z.strictObject({ search: reportRunSearchSchema }),
    z.strictObject({ sweepId: idSchema }),
    z.strictObject({ savedViewId: idSchema }),
  ]),
);

export const reportBlockSchema = namedContractSchema(
  'ReportBlock',
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('markdown'), id: z.string(), text: z.string() }),
    z.strictObject({
      type: z.literal('chart'),
      id: z.string(),
      panel: chartPanelConfigSchema,
      runSet: reportRunSetSchema,
      mode: embedModeSchema,
    }),
    z.strictObject({
      type: z.literal('parallel_coordinates'),
      id: z.string(),
      runSet: reportRunSetSchema,
      params: z.array(z.string()).optional(),
      metric: z.string(),
      mode: embedModeSchema,
    }),
    z.strictObject({
      type: z.literal('parameter_importance'),
      id: z.string(),
      runSet: reportRunSetSchema,
      targetMetric: z.string().optional(),
      mode: embedModeSchema,
    }),
    z.strictObject({
      type: z.literal('scatter'),
      id: z.string(),
      runSet: reportRunSetSchema,
      x: z.string(),
      y: z.string(),
      color: z.string().optional(),
      mode: embedModeSchema,
    }),
    z.strictObject({
      type: z.literal('run_table'),
      id: z.string(),
      runSet: reportRunSetSchema,
      columns: z.array(z.string()),
      limit: z.number().int(),
      mode: embedModeSchema,
    }),
    z.strictObject({
      type: z.literal('media'),
      id: z.string(),
      runIds: z.array(idSchema),
      key: z.string(),
      steps: z.array(z.number().int()).optional(),
      mode: embedModeSchema,
    }),
    z.strictObject({
      type: z.literal('media_table'),
      id: z.string(),
      runId: idSchema,
      mediaId: idSchema,
      mode: embedModeSchema,
    }),
  ]),
);

export const reportUserSchema = namedContractSchema(
  'ReportUser',
  z.strictObject({ id: idSchema, displayName: z.string() }),
);

export const reportSchema = namedContractSchema(
  'Report',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    title: z.string(),
    currentRevision: z.number().int(),
    createdBy: reportUserSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archivedAt: timestampSchema.nullable(),
    archivedBy: reportUserSchema.nullable(),
  }),
);

const reportRevisionSummaryShape = {
  reportId: idSchema,
  revision: z.number().int(),
  title: z.string(),
  message: z.string().nullable(),
  createdBy: reportUserSchema,
  createdAt: timestampSchema,
  restoredFromRevision: z.number().int().nullable(),
};

export const reportRevisionSummarySchema = namedContractSchema(
  'ReportRevisionSummary',
  z.strictObject(reportRevisionSummaryShape),
);

export const reportRevisionSchema = namedContractSchema(
  'ReportRevision',
  z.strictObject({ ...reportRevisionSummaryShape, blocks: z.array(reportBlockSchema) }),
);

export const reportDetailSchema = namedContractSchema(
  'ReportDetail',
  z.strictObject({ report: reportSchema, revision: reportRevisionSchema }),
);

export const reportPageSchema = namedContractSchema('ReportPage', cursorPageOf(reportSchema));

export const reportRevisionListSchema = namedContractSchema(
  'ReportRevisionList',
  itemsOf(reportRevisionSummarySchema),
);

const snapshotRunSchema = z.strictObject({ runId: idSchema, name: z.string() });

export const reportBlockSnapshotSchema = namedContractSchema(
  'ReportBlockSnapshot',
  z.strictObject({
    blockId: z.string(),
    capturedRevision: z.number().int(),
    capturedAt: timestampSchema,
    sizeBytes: z.number().int(),
    data: z.discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('chart'),
        runs: z.array(snapshotRunSchema),
        series: z.array(metricSeriesSchema).optional(),
        groups: z.array(metricGroupSchema).optional(),
      }),
      z.strictObject({
        type: z.literal('parallel_coordinates'),
        table: runAnalysisTableResponseSchema,
      }),
      z.strictObject({
        type: z.literal('parameter_importance'),
        importance: parameterImportanceResultSchema,
      }),
      z.strictObject({ type: z.literal('scatter'), table: runAnalysisTableResponseSchema }),
      // Run summaries carry the extra columns of native Run responses (see runSchema).
      z.strictObject({ type: z.literal('run_table'), runs: z.array(runSchema) }),
      z.strictObject({ type: z.literal('media'), grid: mediaCompareGridSchema }),
      z.strictObject({ type: z.literal('media_table'), page: mediaTablePageSchema }),
    ]),
  }),
);

export const reportSnapshotListSchema = namedContractSchema(
  'ReportSnapshotList',
  z.strictObject({ revision: z.number().int(), items: z.array(reportBlockSnapshotSchema) }),
);

type _ReportRunSet = Expect<MutuallyAssignable<z.infer<typeof reportRunSetSchema>, ReportRunSet>>;
type _ReportBlock = Expect<MutuallyAssignable<z.infer<typeof reportBlockSchema>, ReportBlock>>;
type _ReportUser = Expect<MutuallyAssignable<z.infer<typeof reportUserSchema>, ReportUser>>;
type _Report = Expect<MutuallyAssignable<z.infer<typeof reportSchema>, Report>>;
type _ReportRevisionSummary = Expect<
  MutuallyAssignable<z.infer<typeof reportRevisionSummarySchema>, ReportRevisionSummary>
>;
type _ReportRevision = Expect<
  MutuallyAssignable<z.infer<typeof reportRevisionSchema>, ReportRevision>
>;
type _ReportDetail = Expect<MutuallyAssignable<z.infer<typeof reportDetailSchema>, ReportDetail>>;
type _ReportPage = Expect<MutuallyAssignable<z.infer<typeof reportPageSchema>, ReportPage>>;
type _ReportBlockSnapshot = Expect<
  MutuallyAssignable<z.infer<typeof reportBlockSnapshotSchema>, ReportBlockSnapshot>
>;
type _ReportSnapshotList = Expect<
  MutuallyAssignable<z.infer<typeof reportSnapshotListSchema>, ReportSnapshotList>
>;
