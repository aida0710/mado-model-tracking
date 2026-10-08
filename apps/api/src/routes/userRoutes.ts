import { Hono } from 'hono';
import { userSearchQuerySchema } from '../domain/validation.js';
import { parse, principal, type ApiEnvironment } from '../http/request.js';
import type { UserDirectoryService } from '../services/userDirectoryService.js';

// Mounted at /api: GET /users and GET /auth/groups back the Project access settings.
export function userRoutes(directory: UserDirectoryService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/users', async (context) => {
    const { query } = parse(userSearchQuerySchema, context.req.query());
    return context.json({ items: await directory.searchUsers(principal(context), query) });
  });
  routes.get('/auth/groups', async (context) =>
    context.json({ items: await directory.listGroups(principal(context)) }),
  );
  return routes;
}
