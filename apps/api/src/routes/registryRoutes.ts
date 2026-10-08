import { Hono } from 'hono';
import type { z } from 'zod';
import type { RegistryService } from '../services/registryService.js';
import type { DatasetContentService } from '../services/datasetContentService.js';
import {
  codeVersionSchema,
  datasetCreateSchema,
  modelCreateSchema,
  modelVersionSchema,
  nameSchema,
  namedEntitySchema,
} from '../domain/validation.js';
import {
  modelAliasAssignmentSchema,
  modelAliasEventQuerySchema,
  modelAliasRemovalSchema,
} from '../domain/modelAliasValidation.js';
import {
  artifactDigestQuerySchema,
  datasetFileListQuerySchema,
  datasetFileTreeQuerySchema,
  datasetVersionRequestSchema,
} from '../domain/datasetContentValidation.js';
import {
  datasetListQuerySchema,
  datasetPatchSchema,
  modelPatchSchema,
} from '../domain/registryLifecycleValidation.js';
import { requestMetadata } from '../http/requestMetadata.js';
import {
  jsonBody,
  parse,
  principal,
  uuidParam,
  type ApiContext,
  type ApiEnvironment,
} from '../http/request.js';

// DELETE bodies are optional: a removal without a reason may send no body at all.
async function optionalJsonBody<T>(context: ApiContext, schema: z.ZodType<T>): Promise<T> {
  if (!(await context.req.raw.clone().text()).trim()) return parse(schema, {});
  return jsonBody(context, schema);
}

function datasetVersionLocation(context: ApiContext) {
  return {
    projectId: uuidParam(context, 'p'),
    datasetId: uuidParam(context, 'id'),
    versionId: uuidParam(context, 'v'),
  };
}

export function registryRoutes(
  registry: RegistryService,
  datasetContent: DatasetContentService,
): Hono<ApiEnvironment> {
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
  routes.get('/:p/models/:id', async (context) =>
    context.json(
      await registry.model(principal(context), uuidParam(context, 'p'), uuidParam(context, 'id')),
    ),
  );
  routes.patch('/:p/models/:id', async (context) =>
    context.json(
      await registry.updateModel(
        principal(context),
        {
          projectId: uuidParam(context, 'p'),
          modelId: uuidParam(context, 'id'),
          input: await jsonBody(context, modelPatchSchema),
        },
        requestMetadata(context),
      ),
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
  routes.get('/:p/models/:id/versions/:v', async (context) =>
    context.json(
      await registry.modelVersion(principal(context), {
        projectId: uuidParam(context, 'p'),
        modelId: uuidParam(context, 'id'),
        versionId: uuidParam(context, 'v'),
      }),
    ),
  );
  routes.put('/:p/models/:id/aliases/:alias', async (context) => {
    const assignment = await jsonBody(context, modelAliasAssignmentSchema);
    return context.json(
      await registry.setAlias(principal(context), uuidParam(context, 'p'), {
        modelId: uuidParam(context, 'id'),
        alias: parse(nameSchema, context.req.param('alias')),
        versionId: assignment.versionId,
        reason: assignment.reason,
        evaluationId: assignment.evaluationId,
      }),
    );
  });
  routes.delete('/:p/models/:id/aliases/:alias', async (context) => {
    const removal = await optionalJsonBody(context, modelAliasRemovalSchema);
    await registry.removeAlias(principal(context), uuidParam(context, 'p'), {
      modelId: uuidParam(context, 'id'),
      alias: parse(nameSchema, context.req.param('alias')),
      reason: removal.reason,
    });
    return context.body(null, 204);
  });
  routes.get('/:p/models/:id/alias-events', async (context) =>
    context.json(
      await registry.aliasEvents(principal(context), uuidParam(context, 'p'), {
        modelId: uuidParam(context, 'id'),
        query: parse(modelAliasEventQuerySchema, context.req.query()),
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
    context.json({
      items: await registry.datasets(
        principal(context),
        uuidParam(context, 'p'),
        parse(datasetListQuerySchema, context.req.query()),
      ),
    }),
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
  routes.get('/:p/datasets/:id', async (context) =>
    context.json(
      await registry.dataset(principal(context), uuidParam(context, 'p'), uuidParam(context, 'id')),
    ),
  );
  routes.patch('/:p/datasets/:id', async (context) =>
    context.json(
      await registry.updateDataset(
        principal(context),
        {
          projectId: uuidParam(context, 'p'),
          datasetId: uuidParam(context, 'id'),
          input: await jsonBody(context, datasetPatchSchema),
        },
        requestMetadata(context),
      ),
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
        input: await jsonBody(context, datasetVersionRequestSchema),
      }),
      201,
    ),
  );
  routes.get('/:p/datasets/:id/versions/:v/files', async (context) =>
    context.json(
      await datasetContent.listFiles(principal(context), {
        ...datasetVersionLocation(context),
        query: parse(datasetFileListQuerySchema, context.req.query()),
      }),
    ),
  );
  routes.get('/:p/datasets/:id/versions/:v/files/tree', async (context) =>
    context.json(
      await datasetContent.fileTree(principal(context), {
        ...datasetVersionLocation(context),
        ...parse(datasetFileTreeQuerySchema, context.req.query()),
      }),
    ),
  );
  // Registered with the registry so it precedes GET /:p/artifacts/:a, which would read
  // `by-digest` as an Artifact ID.
  routes.get('/:p/artifacts/by-digest', async (context) =>
    context.json(
      await datasetContent.findArtifactByDigest(principal(context), {
        projectId: uuidParam(context, 'p'),
        ...parse(artifactDigestQuerySchema, context.req.query()),
      }),
    ),
  );
  return routes;
}
