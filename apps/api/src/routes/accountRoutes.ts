import { Hono } from 'hono';
import { principal, type ApiEnvironment } from '../http/request.js';
import type { AccountService } from '../services/accountService.js';

// Mounted at /api/account: the signed-in user's own profile.
export function accountRoutes(account: AccountService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/', async (context) => context.json(await account.get(principal(context))));
  return routes;
}
