import { Hono } from 'hono';
import type { ApiConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requireProject } from '../services/accessService.js';

// MLflow 3.17+ reads <tracking URI>/api/3.0/mlflow/server-info; earlier clients used /server-info.
const SERVER_INFO_PATHS = ['/server-info', '/api/3.0/mlflow/server-info'] as const;

export function mlflowInformationRoutes(
  database: Database,
  multipart: ApiConfig['mlflowMultipart'],
): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  for (const path of SERVER_INFO_PATHS)
    routes.get(path, async (context) => {
      await requireProject(database, principal(context), {
        projectId: uuidParam(context, 'p'),
        role: 'viewer',
        scope: 'read',
      });
      return context.json({
        mlflow_compatibility: '3',
        multipart_uploads_enabled: multipart.uploadsEnabled,
        multipart_downloads_enabled: multipart.downloadsEnabled,
      });
    });
  return routes;
}
