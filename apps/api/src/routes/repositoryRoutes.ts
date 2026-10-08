import { Hono } from 'hono';
import { repositoryFilesSchema } from '../domain/codeSourceValidation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { RepositoryFilesService } from '../services/repositoryFilesService.js';

export function repositoryRoutes(repositories: RepositoryFilesService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/repository-files', async (context) =>
    context.json(
      await repositories.read(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, repositoryFilesSchema),
      ),
    ),
  );
  return routes;
}
