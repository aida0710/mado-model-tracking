import { Hono } from 'hono';
import { nameSchema } from '../domain/validation.js';
import {
  modelAliasProtectionInputSchema,
  modelAliasProtectionQuerySchema,
} from '../domain/modelAliasValidation.js';
import {
  jsonBody,
  parse,
  principal,
  uuidParam,
  type ApiContext,
  type ApiEnvironment,
} from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { AliasProtectionService } from '../services/aliasProtectionService.js';

// ?modelId= names a Model's own protection; without it the protection covers the whole Project.
function protectionTarget(context: ApiContext) {
  const { modelId } = parse(modelAliasProtectionQuerySchema, context.req.query());
  return {
    projectId: uuidParam(context, 'p'),
    modelId: modelId ?? null,
    alias: parse(nameSchema, context.req.param('alias')),
  };
}

export function aliasProtectionRoutes(protections: AliasProtectionService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/alias-protections', async (context) => {
    const { modelId } = parse(modelAliasProtectionQuerySchema, context.req.query());
    return context.json({
      items: await protections.list(principal(context), {
        projectId: uuidParam(context, 'p'),
        modelId,
      }),
    });
  });
  routes.put('/:p/alias-protections/:alias', async (context) =>
    context.json(
      await protections.set(
        principal(context),
        {
          ...protectionTarget(context),
          input: await jsonBody(context, modelAliasProtectionInputSchema),
        },
        requestMetadata(context),
      ),
    ),
  );
  routes.delete('/:p/alias-protections/:alias', async (context) => {
    await protections.remove(
      principal(context),
      protectionTarget(context),
      requestMetadata(context),
    );
    return context.body(null, 204);
  });
  return routes;
}
