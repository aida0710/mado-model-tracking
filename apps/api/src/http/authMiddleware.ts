import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AuthService } from '../services/authService.js';
import { DomainError } from '../domain/errors.js';
import type { ApiEnvironment } from './request.js';

export const SESSION_COOKIE = 'mmt_session';
export const LOGIN_BINDING_COOKIE = 'mmt_login_binding';

export function validateOrigin(origin: string | undefined, allowedOrigins: string[]): void {
  if (!origin || !allowedOrigins.includes(origin))
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
      validateOrigin(context.req.header('Origin'), [auth.config.webOrigin, auth.config.publicUrl]);
    }
    await next();
  };
}
