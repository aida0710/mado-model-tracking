import { Hono } from 'hono';
import {
  adminUserCreateSchema,
  adminUserPatchSchema,
  adminUserQuerySchema,
} from '../domain/adminUserValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { UserAdministrationService } from '../services/userAdministrationService.js';

// Mounted at /api/admin; every operation requires a global administrator's browser session.
export function adminUserRoutes(users: UserAdministrationService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/users', async (context) =>
    context.json({
      items: await users.list(principal(context), parse(adminUserQuerySchema, context.req.query())),
    }),
  );
  routes.post('/users', async (context) =>
    context.json(
      await users.create(
        principal(context),
        await jsonBody(context, adminUserCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.patch('/users/:id', async (context) =>
    context.json(
      await users.update(
        principal(context),
        uuidParam(context, 'id'),
        await jsonBody(context, adminUserPatchSchema),
        requestMetadata(context),
      ),
    ),
  );
  routes.post('/users/:id/reset-password', async (context) =>
    context.json(
      await users.resetPassword(
        principal(context),
        uuidParam(context, 'id'),
        requestMetadata(context),
      ),
    ),
  );
  return routes;
}
