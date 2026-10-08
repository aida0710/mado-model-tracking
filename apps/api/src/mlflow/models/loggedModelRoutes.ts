import { Hono } from 'hono';
import { z } from 'zod';
import {
  jsonBody,
  parse,
  principal,
  uuidParam,
  type ApiEnvironment,
  type ApiContext,
} from '../../http/request.js';
import type { LoggedModelService } from './loggedModelService.js';
import {
  createLoggedModelSchema,
  deleteLoggedModelSchema,
  finalizeSchema,
  loggedModelIdSchema,
  loggedModelTagsSchema,
  loggedModelParamsSchema,
  searchLoggedModelsSchema,
  keySchema,
  invalidParameter,
} from './validation.js';

import { READY_LOGGED_MODEL_STATUS } from './limits.js';

const loggedModelPath = '/api/2.0/mlflow/logged-models';
function modelId(context: ApiContext): string {
  return parse(loggedModelIdSchema, context.req.param('model_id'));
}
function assertBodyModelId(context: ApiContext, bodyId?: string): string {
  const id = modelId(context);
  if (bodyId && bodyId !== id) invalidParameter('pathとbodyのmodel_idが一致しません');
  return id;
}

export function loggedModelRoutes(models: LoggedModelService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post(loggedModelPath, async (context) =>
    context.json({
      model: await models.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, createLoggedModelSchema),
      ),
    }),
  );
  // Search is registered before the dynamic id route.
  routes.post(`${loggedModelPath}/search`, async (context) =>
    context.json(
      await models.search(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, searchLoggedModelsSchema),
      ),
    ),
  );
  routes.get(`${loggedModelPath}/:model_id`, async (context) => {
    const query = parse(
      z.strictObject({ allow_deleted: z.enum(['true', 'false']).optional() }),
      context.req.query(),
    );
    return context.json({
      model: await models.get(principal(context), uuidParam(context, 'p'), {
        id: modelId(context),
        allowDeleted: query.allow_deleted === 'true',
      }),
    });
  });
  routes.patch(`${loggedModelPath}/:model_id`, async (context) => {
    const body = await jsonBody(context, finalizeSchema);
    return context.json({
      model: await models.finalize(principal(context), uuidParam(context, 'p'), {
        id: assertBodyModelId(context, body.model_id),
        status:
          body.status === READY_LOGGED_MODEL_STATUS || body.status === 'LOGGED_MODEL_READY'
            ? 'READY'
            : 'FAILED',
      }),
    });
  });
  routes.delete(`${loggedModelPath}/:model_id`, async (context) => {
    const body = context.req.header('Content-Type')?.includes('application/json')
      ? await jsonBody(context, deleteLoggedModelSchema)
      : {};
    await models.delete(
      principal(context),
      uuidParam(context, 'p'),
      assertBodyModelId(context, body.model_id),
    );
    return context.json({});
  });
  routes.patch(`${loggedModelPath}/:model_id/tags`, async (context) => {
    const body = await jsonBody(context, loggedModelTagsSchema);
    return context.json({
      model: await models.setTags(principal(context), uuidParam(context, 'p'), {
        id: assertBodyModelId(context, body.model_id),
        tags: body.tags,
      }),
    });
  });
  routes.delete(`${loggedModelPath}/:model_id/tags/:tag_key`, async (context) => {
    await models.deleteTag(principal(context), uuidParam(context, 'p'), {
      id: modelId(context),
      key: parse(keySchema, context.req.param('tag_key')),
    });
    return context.json({});
  });
  routes.post(`${loggedModelPath}/:model_id/params`, async (context) => {
    const body = await jsonBody(context, loggedModelParamsSchema);
    await models.logParams(principal(context), uuidParam(context, 'p'), {
      id: assertBodyModelId(context, body.model_id),
      params: body.params,
    });
    return context.json({});
  });
  return routes;
}
