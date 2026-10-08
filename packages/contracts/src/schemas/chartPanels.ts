import { z } from 'zod';
import type {
  ChartPanelConfig,
  ChartPanelLayout,
  ChartSmoothing,
  ChartXAxis,
  RunGroupBy,
} from '../chartPanels.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const chartXAxisSchema = namedContractSchema(
  'ChartXAxis',
  z.strictObject({
    kind: z.enum(['step', 'relative_time', 'wall_time', 'metric']),
    metricKey: z.string().optional(),
  }),
);
export const chartSmoothingSchema = namedContractSchema(
  'ChartSmoothing',
  z.strictObject({
    kind: z.enum(['none', 'ema', 'gaussian', 'running_average']),
    weight: z.number(),
  }),
);
export const runGroupBySchema = namedContractSchema(
  'RunGroupBy',
  z.strictObject({
    kind: z.enum(['tag', 'param', 'experiment']),
    key: z.string().optional(),
  }),
);
export const chartPanelConfigSchema = namedContractSchema(
  'ChartPanelConfig',
  z.strictObject({
    id: z.string(),
    title: z.string().optional(),
    metricKeys: z.array(z.string()),
    xAxis: chartXAxisSchema,
    yScale: z.enum(['linear', 'log']),
    smoothing: chartSmoothingSchema,
    showRange: z.boolean(),
    groupBy: runGroupBySchema.optional(),
    layout: z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  }),
);
export const chartPanelLayoutSchema = namedContractSchema(
  'ChartPanelLayout',
  z.strictObject({
    version: z.literal(1),
    columns: z.literal(12),
    panels: z.array(chartPanelConfigSchema),
  }),
);

type _ChartXAxis = Expect<MutuallyAssignable<z.infer<typeof chartXAxisSchema>, ChartXAxis>>;
type _ChartSmoothing = Expect<
  MutuallyAssignable<z.infer<typeof chartSmoothingSchema>, ChartSmoothing>
>;
type _RunGroupBy = Expect<MutuallyAssignable<z.infer<typeof runGroupBySchema>, RunGroupBy>>;
type _ChartPanelConfig = Expect<
  MutuallyAssignable<z.infer<typeof chartPanelConfigSchema>, ChartPanelConfig>
>;
type _ChartPanelLayout = Expect<
  MutuallyAssignable<z.infer<typeof chartPanelLayoutSchema>, ChartPanelLayout>
>;
