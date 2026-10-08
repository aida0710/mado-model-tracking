import { Hono } from 'hono';
import type { Database } from '../db/database.js';
import { principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requireProject } from '../services/accessService.js';

export function mlflowInformationRoutes(database: Database): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/server-info', async (context) => {
    await requireProject(database, principal(context), {
      projectId: uuidParam(context, 'p'),
      role: 'viewer',
      scope: 'read',
    });
    return context.json({
      mlflow_compatibility: '3',
      multipart_uploads_enabled: false,
      multipart_downloads_enabled: false,
    });
  });
  return routes;
}
