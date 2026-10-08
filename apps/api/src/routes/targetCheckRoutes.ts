import { Hono } from 'hono';
import {
  targetCheckClaimSchema,
  targetCheckCompleteSchema,
} from '../domain/targetCheckValidation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { TargetCheckService } from '../services/targetCheckService.js';

// Mounted at /api: administrators request checks, workers claim and report them.
export function targetCheckRoutes(checks: TargetCheckService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/targets/:id/checks', async (context) =>
    context.json(await checks.request(principal(context), uuidParam(context, 'id')), 201),
  );
  routes.get('/targets/:id/checks', async (context) =>
    context.json({ items: await checks.list(principal(context), uuidParam(context, 'id')) }),
  );
  routes.post('/worker/target-checks/claim', async (context) =>
    context.json({
      item: await checks.claim(principal(context), await jsonBody(context, targetCheckClaimSchema)),
    }),
  );
  routes.post('/worker/target-checks/:id/complete', async (context) =>
    context.json(
      await checks.complete(
        principal(context),
        uuidParam(context, 'id'),
        await jsonBody(context, targetCheckCompleteSchema),
      ),
    ),
  );
  return routes;
}
