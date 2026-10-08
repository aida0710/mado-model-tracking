import { Hono } from 'hono';
import type { ServiceAccountService } from '../services/serviceAccountService.js';
import {
  serviceAccountCreateSchema,
  serviceAccountTokenCreateSchema,
  serviceAccountUpdateSchema,
} from '../domain/serviceAccountValidation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';

export function serviceAccountRoutes(serviceAccounts: ServiceAccountService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/service-accounts', async (context) =>
    context.json({
      items: await serviceAccounts.list(principal(context), uuidParam(context, 'p')),
    }),
  );
  routes.post('/:p/service-accounts', async (context) =>
    context.json(
      await serviceAccounts.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, serviceAccountCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.patch('/:p/service-accounts/:id', async (context) =>
    context.json(
      await serviceAccounts.update(
        principal(context),
        { projectId: uuidParam(context, 'p'), serviceAccountId: uuidParam(context, 'id') },
        await jsonBody(context, serviceAccountUpdateSchema),
        requestMetadata(context),
      ),
    ),
  );
  routes.post('/:p/service-accounts/:id/tokens', async (context) =>
    context.json(
      await serviceAccounts.createToken(
        principal(context),
        { projectId: uuidParam(context, 'p'), serviceAccountId: uuidParam(context, 'id') },
        await jsonBody(context, serviceAccountTokenCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  return routes;
}
