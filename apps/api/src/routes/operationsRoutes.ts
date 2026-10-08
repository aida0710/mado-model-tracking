import { Hono } from 'hono';
import { operationsAlertQuerySchema } from '../domain/operationsAlerts.js';
import { parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { OperationsAlertService } from '../services/operationsAlertService.js';

/** Mounted at /api/projects. */
export function operationsRoutes(alerts: OperationsAlertService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/operations-alerts', async (context) => {
    const filter = parse(operationsAlertQuerySchema, context.req.query());
    return context.json({
      items: await alerts.list(principal(context), uuidParam(context, 'p'), filter),
    });
  });
  return routes;
}
