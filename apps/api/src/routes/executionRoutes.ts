import { Hono } from 'hono';
import type { JobService } from '../services/jobService.js';
import type { TargetService } from '../services/targetService.js';
import type { WorkerService } from '../services/workerService.js';
import {
  completeSchema,
  heartbeatSchema,
  jobCreateSchema,
  targetSchema,
  targetPatchSchema,
  workerClaimSchema,
  workerResumeSchema,
  workerLogSchema,
  workerMetricSchema,
} from '../domain/validation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

export function targetRoutes(targets: TargetService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/', async (context) =>
    context.json({ items: await targets.list(principal(context)) }),
  );
  routes.post('/', async (context) =>
    context.json(
      await targets.create(principal(context), await jsonBody(context, targetSchema)),
      201,
    ),
  );
  routes.patch('/:id', async (context) =>
    context.json(
      await targets.patch(
        principal(context),
        uuidParam(context, 'id'),
        await jsonBody(context, targetPatchSchema),
      ),
    ),
  );
  return routes;
}

export function jobRoutes(jobs: JobService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/jobs', async (context) =>
    context.json({ items: await jobs.list(principal(context), uuidParam(context, 'p')) }),
  );
  routes.post('/:p/jobs', async (context) =>
    context.json(
      await jobs.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, jobCreateSchema),
      ),
      201,
    ),
  );
  routes.post('/:p/jobs/:j/cancel', async (context) =>
    context.json(
      await jobs.cancel(principal(context), uuidParam(context, 'p'), uuidParam(context, 'j')),
    ),
  );
  routes.post('/:p/jobs/:j/retry', async (context) =>
    context.json(
      await jobs.retry(principal(context), uuidParam(context, 'p'), uuidParam(context, 'j')),
      201,
    ),
  );
  return routes;
}

export function workerRoutes(worker: WorkerService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/claim', async (context) =>
    context.json({
      item: await worker.claim(principal(context), await jsonBody(context, workerClaimSchema)),
    }),
  );
  routes.post('/resume', async (context) =>
    context.json({
      items: await worker.resume(principal(context), await jsonBody(context, workerResumeSchema)),
    }),
  );
  routes.post('/jobs/:id/heartbeat', async (context) =>
    context.json(
      await worker.heartbeat(
        principal(context),
        uuidParam(context, 'id'),
        await jsonBody(context, heartbeatSchema),
      ),
    ),
  );
  routes.post('/jobs/:id/metrics', async (context) => {
    await worker.metrics(
      principal(context),
      uuidParam(context, 'id'),
      await jsonBody(context, workerMetricSchema),
    );
    return context.body(null, 204);
  });
  routes.post('/jobs/:id/logs', async (context) => {
    await worker.logs(
      principal(context),
      uuidParam(context, 'id'),
      await jsonBody(context, workerLogSchema),
    );
    return context.body(null, 204);
  });
  routes.post('/jobs/:id/complete', async (context) =>
    context.json(
      await worker.complete(
        principal(context),
        uuidParam(context, 'id'),
        await jsonBody(context, completeSchema),
      ),
    ),
  );
  return routes;
}
