import { Hono } from 'hono';
import type { TokenService } from '../services/tokenService.js';
import { tokenCreateSchema } from '../domain/validation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

export function tokenRoutes(tokens: TokenService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/', async (context) =>
    context.json({ items: await tokens.list(principal(context)) }),
  );
  routes.post('/', async (context) =>
    context.json(
      await tokens.create(principal(context), await jsonBody(context, tokenCreateSchema)),
      201,
    ),
  );
  routes.delete('/:id', async (context) => {
    await tokens.revoke(principal(context), uuidParam(context, 'id'));
    return context.body(null, 204);
  });
  return routes;
}
