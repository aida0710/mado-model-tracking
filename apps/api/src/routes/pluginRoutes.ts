import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginService } from '../services/pluginService.js';
import {
  pluginCreateSchema,
  pluginDatasetSchema,
  pluginPatchSchema,
} from '../domain/validation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

export const pluginDatasetSearchSchema = z.strictObject({ query: z.string().max(1000) });
export const pluginDatasetImportSchema = z.strictObject({ dataset: pluginDatasetSchema });

export function pluginRoutes(plugins: PluginService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/plugins', async (context) =>
    context.json({ items: await plugins.list(principal(context), uuidParam(context, 'p')) }),
  );
  routes.post('/:p/plugins', async (context) =>
    context.json(
      await plugins.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, pluginCreateSchema),
      ),
      201,
    ),
  );
  routes.patch('/:p/plugins/:id', async (context) =>
    context.json(
      await plugins.patch(principal(context), uuidParam(context, 'p'), {
        pluginId: uuidParam(context, 'id'),
        input: await jsonBody(context, pluginPatchSchema),
      }),
    ),
  );
  routes.post('/:p/plugins/:id/check', async (context) =>
    context.json(
      await plugins.check(principal(context), uuidParam(context, 'p'), uuidParam(context, 'id')),
    ),
  );
  routes.get('/:p/plugins/:id/metrics', async (context) =>
    context.json(
      await plugins.metrics(principal(context), uuidParam(context, 'p'), uuidParam(context, 'id')),
    ),
  );
  routes.post('/:p/plugins/:id/datasets/search', async (context) => {
    const input = await jsonBody(context, pluginDatasetSearchSchema);
    return context.json(
      await plugins.search(principal(context), uuidParam(context, 'p'), {
        pluginId: uuidParam(context, 'id'),
        query: input.query,
      }),
    );
  });
  routes.post('/:p/plugins/:id/datasets/import', async (context) => {
    const input = await jsonBody(context, pluginDatasetImportSchema);
    return context.json(
      await plugins.importDataset(principal(context), uuidParam(context, 'p'), {
        pluginId: uuidParam(context, 'id'),
        dataset: input.dataset,
      }),
      201,
    );
  });
  routes.post('/:p/plugins/:id/events/retry', async (context) =>
    context.json(
      await plugins.retryEvents(
        principal(context),
        uuidParam(context, 'p'),
        uuidParam(context, 'id'),
      ),
    ),
  );
  return routes;
}
