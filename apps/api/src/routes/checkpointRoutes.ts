import { Hono } from 'hono';
import {
  runCheckpointCreateSchema,
  runCheckpointListQuerySchema,
} from '../domain/checkpointValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { CheckpointService } from '../services/checkpointService.js';

export function checkpointRoutes(checkpoints: CheckpointService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/runs/:r/checkpoints', async (context) => {
    const query = parse(runCheckpointListQuerySchema, context.req.query());
    return context.json({
      items: await checkpoints.list(principal(context), {
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
        includeHidden: query.includeHidden === 'true',
      }),
    });
  });
  routes.post('/:p/runs/:r/checkpoints', async (context) =>
    context.json(
      await checkpoints.create(
        principal(context),
        { projectId: uuidParam(context, 'p'), runId: uuidParam(context, 'r') },
        await jsonBody(context, runCheckpointCreateSchema),
      ),
      201,
    ),
  );
  return routes;
}
