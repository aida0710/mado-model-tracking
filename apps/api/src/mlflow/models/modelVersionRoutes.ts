import { Hono } from 'hono';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../../http/request.js';
import type { RegisteredModelService } from './registeredModelService.js';
import type { ModelVersionService } from './modelVersionService.js';
import { registrySearchQuery } from './registeredModelRoutes.js';
import {
  createModelVersionSchema,
  modelVersionReferenceSchema,
  latestVersionsSchema,
  updateVersionSchema,
  transitionStageSchema,
  setVersionTagSchema,
  deleteVersionTagSchema,
} from './validation.js';

const versionPath = '/api/2.0/mlflow/model-versions';
export function modelVersionRoutes(services: {
  versions: ModelVersionService;
  models: RegisteredModelService;
}): Hono<ApiEnvironment> {
  const { versions, models } = services;
  const routes = new Hono<ApiEnvironment>();
  routes.post(`${versionPath}/create`, async (context) =>
    context.json({
      model_version: await versions.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, createModelVersionSchema),
      ),
    }),
  );
  routes.get(`${versionPath}/get`, async (context) =>
    context.json({
      model_version: await versions.get(
        principal(context),
        uuidParam(context, 'p'),
        parse(modelVersionReferenceSchema, context.req.query()),
      ),
    }),
  );
  routes.get(`${versionPath}/get-download-uri`, async (context) =>
    context.json({
      artifact_uri: await versions.downloadUri(
        principal(context),
        uuidParam(context, 'p'),
        parse(modelVersionReferenceSchema, context.req.query()),
      ),
    }),
  );
  routes.get(`${versionPath}/search`, async (context) =>
    context.json(
      await models.searchVersions(
        principal(context),
        uuidParam(context, 'p'),
        registrySearchQuery(context),
      ),
    ),
  );
  routes.patch(`${versionPath}/update`, async (context) =>
    context.json({
      model_version: await versions.update(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, updateVersionSchema),
      ),
    }),
  );
  routes.delete(`${versionPath}/delete`, async (context) => {
    await versions.delete(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, modelVersionReferenceSchema),
    );
    return context.json({});
  });
  routes.post(`${versionPath}/transition-stage`, async (context) =>
    context.json({
      model_version: await versions.transitionStage(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, transitionStageSchema),
      ),
    }),
  );
  routes.post(`${versionPath}/set-tag`, async (context) => {
    await versions.setTag(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, setVersionTagSchema),
    );
    return context.json({});
  });
  routes.delete(`${versionPath}/delete-tag`, async (context) => {
    await versions.setTag(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, deleteVersionTagSchema),
    );
    return context.json({});
  });
  routes.post('/api/2.0/mlflow/registered-models/get-latest-versions', async (context) =>
    context.json({
      model_versions: await versions.latest(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, latestVersionsSchema),
      ),
    }),
  );
  return routes;
}
