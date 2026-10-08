import { Hono } from 'hono';
import {
  jsonBody,
  parse,
  principal,
  uuidParam,
  type ApiContext,
  type ApiEnvironment,
} from '../../http/request.js';
import type { RegisteredModelService } from './registeredModelService.js';
import {
  createRegisteredModelSchema,
  registeredModelReferenceSchema,
  updateModelSchema,
  renameModelSchema,
  searchRegistrySchema,
  aliasReferenceSchema,
  setAliasSchema,
  setModelTagSchema,
  deleteModelTagSchema,
} from './validation.js';

const registryPath = '/api/2.0/mlflow/registered-models';
export function registrySearchQuery(context: ApiContext) {
  return parse(searchRegistrySchema, {
    ...context.req.query(),
    order_by: context.req.queries('order_by') ?? [],
  });
}

export function registeredModelRoutes(models: RegisteredModelService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post(`${registryPath}/create`, async (context) =>
    context.json({
      registered_model: await models.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, createRegisteredModelSchema),
      ),
    }),
  );
  routes.get(`${registryPath}/get`, async (context) => {
    const reference = parse(registeredModelReferenceSchema, context.req.query());
    return context.json({
      registered_model: await models.get(
        principal(context),
        uuidParam(context, 'p'),
        reference.name,
      ),
    });
  });
  routes.get(`${registryPath}/search`, async (context) =>
    context.json(
      await models.search(
        principal(context),
        uuidParam(context, 'p'),
        registrySearchQuery(context),
      ),
    ),
  );
  routes.patch(`${registryPath}/update`, async (context) =>
    context.json({
      registered_model: await models.update(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, updateModelSchema),
      ),
    }),
  );
  routes.post(`${registryPath}/rename`, async (context) =>
    context.json({
      registered_model: await models.rename(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, renameModelSchema),
      ),
    }),
  );
  routes.delete(`${registryPath}/delete`, async (context) => {
    const reference = await jsonBody(context, registeredModelReferenceSchema);
    await models.delete(principal(context), uuidParam(context, 'p'), reference.name);
    return context.json({});
  });
  routes.post(`${registryPath}/set-tag`, async (context) => {
    await models.setTag(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, setModelTagSchema),
    );
    return context.json({});
  });
  routes.delete(`${registryPath}/delete-tag`, async (context) => {
    await models.setTag(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, deleteModelTagSchema),
    );
    return context.json({});
  });
  routes.post(`${registryPath}/alias`, async (context) => {
    await models.setAlias(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, setAliasSchema),
    );
    return context.json({});
  });
  routes.delete(`${registryPath}/alias`, async (context) => {
    await models.deleteAlias(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, aliasReferenceSchema),
    );
    return context.json({});
  });
  routes.get(`${registryPath}/alias`, async (context) =>
    context.json({
      model_version: await models.byAlias(
        principal(context),
        uuidParam(context, 'p'),
        parse(aliasReferenceSchema, context.req.query()),
      ),
    }),
  );
  return routes;
}
