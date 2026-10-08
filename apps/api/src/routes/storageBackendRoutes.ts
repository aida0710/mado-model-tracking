import { Hono } from 'hono';
import { isValidStorageBackendName } from '@mmt/platform';
import {
  storageBackendCreateSchema,
  storageBackendPatchSchema,
  storageSettingsSchema,
} from '../domain/storageBackendValidation.js';
import { DomainError } from '../domain/errors.js';
import { jsonBody, principal, type ApiContext, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { StorageBackendService } from '../services/storageBackendService.js';

function backendName(context: ApiContext): string {
  const name = context.req.param('name');
  // Anything outside the stored name rule cannot name an existing backend.
  if (!name || !isValidStorageBackendName(name))
    throw new DomainError(404, '保存先が見つかりません', 'not_found');
  return name;
}

// Mounted at /api/admin; every operation requires a global administrator.
export function storageBackendRoutes(storage: StorageBackendService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/storage-backends', async (context) =>
    context.json({ items: await storage.list(principal(context)) }),
  );
  routes.post('/storage-backends', async (context) =>
    context.json(
      await storage.create(
        principal(context),
        await jsonBody(context, storageBackendCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.patch('/storage-backends/:name', async (context) =>
    context.json(
      await storage.update(
        principal(context),
        backendName(context),
        await jsonBody(context, storageBackendPatchSchema),
        requestMetadata(context),
      ),
    ),
  );
  routes.post('/storage-backends/:name/test', async (context) =>
    context.json(
      await storage.test(principal(context), backendName(context), requestMetadata(context)),
    ),
  );
  routes.get('/storage-settings', async (context) =>
    context.json(await storage.getSettings(principal(context))),
  );
  routes.put('/storage-settings', async (context) =>
    context.json(
      await storage.updateSettings(
        principal(context),
        await jsonBody(context, storageSettingsSchema),
        requestMetadata(context),
      ),
    ),
  );
  return routes;
}
