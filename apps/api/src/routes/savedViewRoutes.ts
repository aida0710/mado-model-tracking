import { Hono } from 'hono';
import {
  savedViewCreateSchema,
  savedViewListQuerySchema,
  savedViewPatchSchema,
} from '../domain/savedViewValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { SavedViewService } from '../services/savedViewService.js';

export function savedViewRoutes(savedViews: SavedViewService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/saved-views', async (context) =>
    context.json(
      await savedViews.list(
        principal(context),
        uuidParam(context, 'p'),
        parse(savedViewListQuerySchema, context.req.query()),
      ),
    ),
  );
  routes.get('/:p/saved-views/:v', async (context) =>
    context.json(
      await savedViews.get(principal(context), {
        projectId: uuidParam(context, 'p'),
        savedViewId: uuidParam(context, 'v'),
      }),
    ),
  );
  routes.post('/:p/saved-views', async (context) =>
    context.json(
      await savedViews.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, savedViewCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.patch('/:p/saved-views/:v', async (context) =>
    context.json(
      await savedViews.update(
        principal(context),
        {
          projectId: uuidParam(context, 'p'),
          savedViewId: uuidParam(context, 'v'),
          patch: await jsonBody(context, savedViewPatchSchema),
        },
        requestMetadata(context),
      ),
    ),
  );
  routes.delete('/:p/saved-views/:v', async (context) => {
    await savedViews.delete(
      principal(context),
      { projectId: uuidParam(context, 'p'), savedViewId: uuidParam(context, 'v') },
      requestMetadata(context),
    );
    return context.body(null, 204);
  });
  return routes;
}
