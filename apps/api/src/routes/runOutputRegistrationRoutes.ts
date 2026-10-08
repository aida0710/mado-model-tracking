import { Hono } from 'hono';
import { principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { RunOutputRegistrationService } from '../services/runOutputRegistrationService.js';

export function runOutputRegistrationRoutes(
  registrations: RunOutputRegistrationService,
): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/runs/:r/output-registration', async (context) =>
    context.json(
      await registrations.get(principal(context), {
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
      }),
    ),
  );
  return routes;
}
