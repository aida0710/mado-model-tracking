import { Hono } from 'hono';
import { z } from 'zod';
import {
  RUN_COMPARISON_MAX_METRIC_KEYS,
  RUN_COMPARISON_MAX_RUNS,
  RUN_COMPARISON_MIN_RUNS,
  RUN_EXPORT_TRUNCATED_HEADER,
} from '@mmt/contracts';
import type { RunService } from '../services/runService.js';
import type { LineageService } from '../services/lineageService.js';
import type { RunComparisonService } from '../services/runComparisonService.js';
import type { RunExportService } from '../services/runExportService.js';
import { CSV_CONTENT_TYPE, csvAttachmentDisposition } from '../domain/csvEncoding.js';
import {
  logBatchSchema,
  metricBatchSchema,
  runCreateSchema,
  runPatchSchema,
  runStatusSchema,
  uuidSchema,
} from '../domain/validation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { runSearchSchema } from './runSearchRoutes.js';

export const runQuerySchema = z.strictObject({
  experimentId: uuidSchema.optional(),
  status: runStatusSchema.optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

// MLflow accepts metric keys up to 250 characters, longer than native metric names.
const MAX_METRIC_KEY_LENGTH = 250;

const comparedRunIdsSchema = z
  .array(uuidSchema)
  .min(RUN_COMPARISON_MIN_RUNS)
  .max(RUN_COMPARISON_MAX_RUNS)
  .refine((ids) => new Set(ids).size === ids.length, 'runIds must be unique');
const comparisonBaseSchema = {
  runIds: comparedRunIdsSchema,
  baselineRunId: uuidSchema.nullable().default(null),
};
const baselineInRunIds = (comparison: { runIds: string[]; baselineRunId: string | null }) =>
  comparison.baselineRunId === null || comparison.runIds.includes(comparison.baselineRunId);
const BASELINE_NOT_COMPARED = {
  message: 'baselineRunId must be one of runIds',
  path: ['baselineRunId'],
};

export const runComparisonSchema = z
  .strictObject({
    ...comparisonBaseSchema,
    metricKeys: z
      .array(z.string().min(1).max(MAX_METRIC_KEY_LENGTH))
      .max(RUN_COMPARISON_MAX_METRIC_KEYS)
      .refine((keys) => new Set(keys).size === keys.length, 'metricKeys must be unique')
      .nullable()
      .default(null),
    includeHistory: z.boolean().default(false),
  })
  .refine(baselineInRunIds, BASELINE_NOT_COMPARED);
// A GET link carries the Run IDs comma-separated, as the Compare page URL does.
export const runComparisonCsvQuerySchema = z
  .strictObject({
    ...comparisonBaseSchema,
    runIds: z
      .string()
      .transform((ids) => ids.split(',').filter(Boolean))
      .pipe(comparedRunIdsSchema),
  })
  .refine(baselineInRunIds, BASELINE_NOT_COMPARED);

export function runRoutes(services: {
  runs: RunService;
  lineage: LineageService;
  runComparison: RunComparisonService;
  runExport: RunExportService;
}): Hono<ApiEnvironment> {
  const { runs, lineage, runComparison, runExport } = services;
  const routes = new Hono<ApiEnvironment>();
  // Registered before /:p/runs/:r, which would otherwise take compare.csv as a Run ID.
  routes.post('/:p/runs/compare', async (context) =>
    context.json(
      await runComparison.compare(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, runComparisonSchema),
      ),
    ),
  );
  routes.get('/:p/runs/compare.csv', async (context) => {
    const query = parse(runComparisonCsvQuerySchema, context.req.query());
    const exported = await runExport.exportComparison(principal(context), uuidParam(context, 'p'), {
      ...query,
      metricKeys: null,
    });
    return context.body(exported.csv, 200, {
      'Content-Type': CSV_CONTENT_TYPE,
      'Content-Disposition': csvAttachmentDisposition(exported.fileName),
    });
  });
  routes.post('/:p/runs/search/export.csv', async (context) => {
    // The body of POST /runs/search is accepted as is; paging fields do not apply to an export.
    const {
      limit: _limit,
      cursor: _cursor,
      ...conditions
    } = await jsonBody(context, runSearchSchema);
    const exported = await runExport.exportSearch(
      principal(context),
      uuidParam(context, 'p'),
      conditions,
    );
    const iterator = exported.chunks[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    // highWaterMark 0: nothing is read from the DB until the client asks for the next chunk.
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        },
        async cancel() {
          await iterator.return?.();
        },
      },
      { highWaterMark: 0 },
    );
    return context.body(body, 200, {
      'Content-Type': CSV_CONTENT_TYPE,
      'Content-Disposition': csvAttachmentDisposition(exported.fileName),
      [RUN_EXPORT_TRUNCATED_HEADER]: String(exported.truncated),
    });
  });
  routes.get('/:p/runs', async (context) => {
    const filter = parse(runQuerySchema, context.req.query());
    return context.json({
      items: await runs.list(principal(context), uuidParam(context, 'p'), {
        ...filter,
        query: filter.q,
      }),
    });
  });
  routes.post('/:p/runs', async (context) =>
    context.json(
      await runs.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, runCreateSchema),
      ),
      201,
    ),
  );
  routes.get('/:p/runs/:r', async (context) =>
    context.json(
      await runs.get(principal(context), uuidParam(context, 'p'), uuidParam(context, 'r')),
    ),
  );
  routes.patch('/:p/runs/:r', async (context) =>
    context.json(
      await runs.patch(principal(context), uuidParam(context, 'p'), {
        runId: uuidParam(context, 'r'),
        input: await jsonBody(context, runPatchSchema),
      }),
    ),
  );
  routes.get('/:p/runs/:r/metrics', async (context) =>
    context.json({
      items: await runs.metrics(
        principal(context),
        uuidParam(context, 'p'),
        uuidParam(context, 'r'),
      ),
    }),
  );
  routes.post('/:p/runs/:r/metrics', async (context) => {
    const input = await jsonBody(context, metricBatchSchema);
    await runs.addMetrics(principal(context), uuidParam(context, 'p'), {
      runId: uuidParam(context, 'r'),
      metrics: input.metrics,
    });
    return context.body(null, 204);
  });
  routes.get('/:p/runs/:r/logs', async (context) =>
    context.json({
      items: await runs.logs(principal(context), uuidParam(context, 'p'), uuidParam(context, 'r')),
    }),
  );
  routes.post('/:p/runs/:r/logs', async (context) => {
    const input = await jsonBody(context, logBatchSchema);
    await runs.addLogs(principal(context), uuidParam(context, 'p'), {
      runId: uuidParam(context, 'r'),
      entries: input.entries,
    });
    return context.body(null, 204);
  });
  routes.get('/:p/lineage', async (context) =>
    context.json(await lineage.graph(principal(context), uuidParam(context, 'p'))),
  );
  return routes;
}
