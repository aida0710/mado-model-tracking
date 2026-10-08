import { Hono } from 'hono';
import { principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { ArtifactPreviewService } from '../services/artifactPreviewService.js';

export function artifactPreviewRoutes(previews: ArtifactPreviewService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/artifacts/:a/previews', async (context) =>
    context.json({
      items: await previews.list(principal(context), {
        projectId: uuidParam(context, 'p'),
        artifactId: uuidParam(context, 'a'),
      }),
    }),
  );
  return routes;
}
