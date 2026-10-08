import { Hono } from 'hono';
import { z } from 'zod';
import { parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { OperationsAlertService } from '../services/operationsAlertService.js';

// The header badge lists open alerts; history views page through at most 200 at a time.
const DEFAULT_ALERT_PAGE_SIZE = 50;
const MAX_ALERT_PAGE_SIZE = 200;

const operationsAlertQuerySchema = z.strictObject({
  state: z.enum(['open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(MAX_ALERT_PAGE_SIZE).default(DEFAULT_ALERT_PAGE_SIZE),
});

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
