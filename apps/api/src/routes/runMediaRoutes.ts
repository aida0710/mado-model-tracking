import { Hono } from 'hono';
import {
  mediaCompareSchema,
  mediaTableQuerySchema,
  runMediaCreateSchema,
  runMediaListQuerySchema,
} from '../domain/runMediaValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { RunMediaService } from '../services/runMediaService.js';

export function runMediaRoutes(media: RunMediaService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/runs/:r/media', async (context) =>
    context.json(
      {
        items: await media.create(
          principal(context),
          { projectId: uuidParam(context, 'p'), runId: uuidParam(context, 'r') },
          await jsonBody(context, runMediaCreateSchema),
        ),
      },
      201,
    ),
  );
  routes.get('/:p/runs/:r/media/keys', async (context) =>
    context.json({
      items: await media.keys(principal(context), {
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
      }),
    }),
  );
  routes.get('/:p/runs/:r/media/:mediaId/table', async (context) =>
    context.json(
      await media.table(
        principal(context),
        {
          projectId: uuidParam(context, 'p'),
          runId: uuidParam(context, 'r'),
          mediaId: uuidParam(context, 'mediaId'),
        },
        parse(mediaTableQuerySchema, context.req.query()),
      ),
    ),
  );
  routes.get('/:p/runs/:r/media', async (context) =>
    context.json(
      await media.list(principal(context), {
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
        ...parse(runMediaListQuerySchema, context.req.query()),
      }),
    ),
  );
  routes.post('/:p/media/compare', async (context) =>
    context.json(
      await media.compare(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, mediaCompareSchema),
      ),
    ),
  );
  return routes;
}
