import {
  DEFAULT_SERIES_POINTS,
  MAX_GROUPED_RUNS,
  MAX_SERIES_KEYS,
  MAX_SERIES_POINTS,
  MAX_SERIES_RUNS,
} from '@mmt/contracts';
import { z } from 'zod';
import { runSearchSchema } from '../../routes/runSearchRoutes.js';
import { uuidSchema } from '../validation.js';

// MLflow accepts metric keys up to 250 characters, longer than native metric names.
const MAX_METRIC_KEY_LENGTH = 250;
// Equal to the native tag and parameter key limit.
const MAX_GROUP_KEY_LENGTH = 200;
/**
 * Bounds runs (or groups) x keys x maxPoints. A million points is a JSON body of tens of MB; a
 * client that needs more Runs or keys lowers maxPoints, which a chart of normal width allows.
 */
export const MAX_RESPONSE_POINTS = 1_000_000;

const metricKeySchema = z.string().min(1).max(MAX_METRIC_KEY_LENGTH);
const uniqueRunIds = (maximum: number) =>
  z
    .array(uuidSchema)
    .min(1)
    .max(maximum)
    .refine((ids) => new Set(ids).size === ids.length, 'runIds must be unique');
const keysSchema = z
  .array(metricKeySchema)
  .min(1)
  .max(MAX_SERIES_KEYS)
  .refine((keys) => new Set(keys).size === keys.length, 'keys must be unique');
const xAxisSchema = z
  .strictObject({
    kind: z.enum(['step', 'relative_time', 'wall_time', 'metric']),
    metricKey: metricKeySchema.optional(),
  })
  .refine(
    (axis) => (axis.kind === 'metric') === (axis.metricKey !== undefined),
    'metricKey is required only for the metric axis',
  );
const xRangeSchema = z
  .strictObject({ min: z.number(), max: z.number() })
  .refine((range) => range.min < range.max, 'xRange.min must be below xRange.max')
  .nullable()
  .default(null);
const maxPointsSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_SERIES_POINTS)
  .default(DEFAULT_SERIES_POINTS);
const groupBySchema = z
  .strictObject({
    kind: z.enum(['tag', 'param', 'experiment']),
    key: z.string().min(1).max(MAX_GROUP_KEY_LENGTH).optional(),
  })
  .refine(
    (groupBy) => (groupBy.kind === 'experiment') === (groupBy.key === undefined),
    'key is required for tag and param grouping only',
  );

export const metricSeriesRequestSchema = z
  .strictObject({
    runIds: uniqueRunIds(MAX_SERIES_RUNS),
    keys: keysSchema,
    xAxis: xAxisSchema,
    maxPoints: maxPointsSchema,
    xRange: xRangeSchema,
  })
  .refine(
    (request) =>
      request.runIds.length * request.keys.length * request.maxPoints <= MAX_RESPONSE_POINTS,
    'runIds x keys x maxPoints exceeds the response limit',
  );

export const metricGroupsRequestSchema = z
  .strictObject({
    runIds: uniqueRunIds(MAX_GROUPED_RUNS).optional(),
    // Groups read every matching Run, so paging conditions do not apply.
    search: runSearchSchema.omit({ limit: true, cursor: true }).optional(),
    groupBy: groupBySchema,
    keys: keysSchema,
    xAxis: xAxisSchema,
    maxPoints: maxPointsSchema,
    xRange: xRangeSchema,
  })
  .refine(
    (request) => (request.runIds === undefined) !== (request.search === undefined),
    'exactly one of runIds and search is required',
  );

export type MetricSeriesQuery = z.infer<typeof metricSeriesRequestSchema>;
export type MetricGroupsQuery = z.infer<typeof metricGroupsRequestSchema>;
export type MetricXAxis = MetricSeriesQuery['xAxis'];
