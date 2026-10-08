import { z } from 'zod';
import type {
  MetricGroup,
  MetricGroupPoint,
  MetricGroupsResponse,
  MetricSeries,
  MetricSeriesPoint,
  MetricSeriesResponse,
} from '../metricSeries.js';
import { idSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const metricSeriesPointSchema = namedContractSchema(
  'MetricSeriesPoint',
  z.strictObject({
    x: z.number(),
    step: z.number(),
    value: z.number(),
    min: z.number(),
    max: z.number(),
    count: z.number().int(),
  }),
);
export const metricSeriesSchema = namedContractSchema(
  'MetricSeries',
  z.strictObject({
    runId: idSchema,
    key: z.string(),
    points: z.array(metricSeriesPointSchema),
    sampled: z.boolean(),
    totalPoints: z.number().int(),
    nanCount: z.number().int(),
    droppedPoints: z.number().int(),
  }),
);
export const metricSeriesResponseSchema = namedContractSchema(
  'MetricSeriesResponse',
  z.strictObject({ series: z.array(metricSeriesSchema) }),
);
export const metricGroupPointSchema = namedContractSchema(
  'MetricGroupPoint',
  z.strictObject({
    x: z.number(),
    mean: z.number(),
    min: z.number(),
    max: z.number(),
    stddev: z.number(),
    runCount: z.number().int(),
  }),
);
export const metricGroupSchema = namedContractSchema(
  'MetricGroup',
  z.strictObject({
    groupKey: z.string(),
    label: z.string(),
    runIds: z.array(idSchema),
    series: z.array(z.strictObject({ key: z.string(), points: z.array(metricGroupPointSchema) })),
  }),
);
export const metricGroupsResponseSchema = namedContractSchema(
  'MetricGroupsResponse',
  z.strictObject({ groups: z.array(metricGroupSchema) }),
);

type _MetricSeriesPoint = Expect<
  MutuallyAssignable<z.infer<typeof metricSeriesPointSchema>, MetricSeriesPoint>
>;
type _MetricSeries = Expect<MutuallyAssignable<z.infer<typeof metricSeriesSchema>, MetricSeries>>;
type _MetricSeriesResponse = Expect<
  MutuallyAssignable<z.infer<typeof metricSeriesResponseSchema>, MetricSeriesResponse>
>;
type _MetricGroupPoint = Expect<
  MutuallyAssignable<z.infer<typeof metricGroupPointSchema>, MetricGroupPoint>
>;
type _MetricGroup = Expect<MutuallyAssignable<z.infer<typeof metricGroupSchema>, MetricGroup>>;
type _MetricGroupsResponse = Expect<
  MutuallyAssignable<z.infer<typeof metricGroupsResponseSchema>, MetricGroupsResponse>
>;
