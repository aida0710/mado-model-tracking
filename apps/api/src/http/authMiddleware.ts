import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AuthService } from '../services/authService.js';
import { DomainError } from '../domain/errors.js';
import type { ApiEnvironment } from './request.js';
import { isAllowedOrigin, type OriginPolicy } from './originPolicy.js';

export const SESSION_COOKIE = 'mmt_session';
export const LOGIN_BINDING_COOKIE = 'mmt_login_binding';

// A session that must change its password may only read who it is, change the password, or leave.
const PASSWORD_CHANGE_ALLOWED_REQUESTS = new Set([
  'GET /api/auth/config',
  'GET /api/auth/me',
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
  'GET /api/health',
]);

export function validateOrigin(origin: string | undefined, policy: OriginPolicy): void {
  if (!isAllowedOrigin(origin, policy))
    throw new DomainError(403, 'リクエストのOriginが許可されていません', 'invalid_origin');
}

export function authentication(auth: AuthService): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header('Authorization');
    let bearer: string | undefined;
    if (authorization) {
      const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
      if (!match) throw new DomainError(401, 'Authorization headerが不正です', 'invalid_token');
      bearer = match[1];
    }
    const session = getCookie(context, SESSION_COOKIE);
    const identity = await auth.authenticate({ bearer, session });
    context.set('principal', identity);
    if (session && !bearer && !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)) {
      validateOrigin(context.req.header('Origin'), auth.config);
    }
    if (
      identity?.session?.mustChangePassword &&
      !PASSWORD_CHANGE_ALLOWED_REQUESTS.has(`${context.req.method} ${context.req.path}`)
    )
      throw new DomainError(
        403,
        'パスワードを変更してから操作してください',
        'password_change_required',
      );
    await next();
  };
}
