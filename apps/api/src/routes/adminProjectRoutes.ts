import { Hono } from 'hono';
import { adminProjectQuerySchema } from '../domain/projectValidation.js';
import { parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { ProjectAdministrationService } from '../services/projectAdministrationService.js';

// Mounted at /api/admin; every operation requires a global administrator.
export function adminProjectRoutes(projects: ProjectAdministrationService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/projects', async (context) =>
    context.json({
      items: await projects.list(
        principal(context),
        parse(adminProjectQuerySchema, context.req.query()),
      ),
    }),
  );
  routes.post('/projects/:p/restore', async (context) =>
    context.json(
      await projects.restore(principal(context), uuidParam(context, 'p'), requestMetadata(context)),
    ),
  );
  routes.delete('/projects/:p', async (context) => {
    await projects.purge(principal(context), uuidParam(context, 'p'), requestMetadata(context));
    return context.body(null, 204);
  });
  return routes;
}
