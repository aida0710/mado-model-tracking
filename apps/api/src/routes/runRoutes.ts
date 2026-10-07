import { Hono } from 'hono';
import { z } from 'zod';
import type { RunService } from '../services/runService.js';
import type { LineageService } from '../services/lineageService.js';
import {
  logBatchSchema,
  metricBatchSchema,
  runCreateSchema,
  runPatchSchema,
  runStatusSchema,
  uuidSchema,
} from '../domain/validation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

const runQuerySchema = z.strictObject({
  experimentId: uuidSchema.optional(),
  status: runStatusSchema.optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export function runRoutes(runs: RunService, lineage: LineageService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
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
