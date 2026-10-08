import { Hono } from 'hono';
import { z } from 'zod';
import type { RegistryService } from '../services/registryService.js';
import {
  codeVersionSchema,
  datasetCreateSchema,
  datasetVersionSchema,
  modelCreateSchema,
  modelVersionSchema,
  nameSchema,
  namedEntitySchema,
  uuidSchema,
} from '../domain/validation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

export function registryRoutes(registry: RegistryService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/models', async (context) =>
    context.json({
      items: await registry.models(principal(context), uuidParam(context, 'p'), {
        name: parse(nameSchema.optional(), context.req.query('name')),
      }),
    }),
  );
  routes.post('/:p/models', async (context) =>
    context.json(
      await registry.createModel(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, modelCreateSchema),
      ),
      201,
    ),
  );
  routes.get('/:p/models/:id/versions', async (context) =>
    context.json({
      items: await registry.modelVersions(
        principal(context),
        uuidParam(context, 'p'),
        uuidParam(context, 'id'),
      ),
    }),
  );
  routes.post('/:p/models/:id/versions', async (context) =>
    context.json(
      await registry.createModelVersion(principal(context), uuidParam(context, 'p'), {
        modelId: uuidParam(context, 'id'),
        input: await jsonBody(context, modelVersionSchema),
      }),
      201,
    ),
  );
  routes.put('/:p/models/:id/aliases/:alias', async (context) =>
    context.json(
      await registry.setAlias(principal(context), uuidParam(context, 'p'), {
        modelId: uuidParam(context, 'id'),
        alias: parse(nameSchema, context.req.param('alias')),
        versionId: (await jsonBody(context, z.strictObject({ versionId: uuidSchema }))).versionId,
      }),
    ),
  );
  routes.get('/:p/codes', async (context) =>
    context.json({ items: await registry.codes(principal(context), uuidParam(context, 'p')) }),
  );
  routes.post('/:p/codes', async (context) =>
    context.json(
      await registry.createCode(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, namedEntitySchema),
      ),
      201,
    ),
  );
  routes.get('/:p/codes/:id/versions', async (context) =>
    context.json({
      items: await registry.codeVersions(
        principal(context),
        uuidParam(context, 'p'),
        uuidParam(context, 'id'),
      ),
    }),
  );
  routes.post('/:p/codes/:id/versions', async (context) =>
    context.json(
      await registry.createCodeVersion(principal(context), uuidParam(context, 'p'), {
        codeId: uuidParam(context, 'id'),
        input: await jsonBody(context, codeVersionSchema),
      }),
      201,
    ),
  );
  routes.get('/:p/datasets', async (context) =>
    context.json({ items: await registry.datasets(principal(context), uuidParam(context, 'p')) }),
  );
  routes.post('/:p/datasets', async (context) =>
    context.json(
      await registry.createDataset(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, datasetCreateSchema),
      ),
      201,
    ),
  );
  routes.get('/:p/datasets/:id/versions', async (context) =>
    context.json({
      items: await registry.datasetVersions(
        principal(context),
        uuidParam(context, 'p'),
        uuidParam(context, 'id'),
      ),
    }),
  );
  routes.post('/:p/datasets/:id/versions', async (context) =>
    context.json(
      await registry.createDatasetVersion(principal(context), uuidParam(context, 'p'), {
        datasetId: uuidParam(context, 'id'),
        input: await jsonBody(context, datasetVersionSchema),
      }),
      201,
    ),
  );
  return routes;
}
