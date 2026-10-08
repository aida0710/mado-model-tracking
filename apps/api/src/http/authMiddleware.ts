import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AuthService } from '../services/authService.js';
import type { JobTokenService } from '../services/jobTokenService.js';
import { isJobToken } from '../auth/jobTokens.js';
import { DomainError } from '../domain/errors.js';
import { isMlflowRequest } from '../mlflow/errors.js';
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

// API tokens (mmt_) and Job tokens (mmtj_) are the prefix and base64url of a random secret.
const API_TOKEN_FORMAT = /^mmtj?_[A-Za-z0-9_-]+$/;

/**
 * Reads the API token from the Authorization header. Bearer works everywhere. Basic is accepted
 * only on the MLflow API, where in-house tools that set MLFLOW_TRACKING_USERNAME/PASSWORD send
 * it: the password must be an API token and the username is ignored. A local account password
 * is never accepted, so Basic cannot be used to guess passwords.
 */
export function apiTokenFromAuthorization(
  authorization: string,
  request: { path: string },
): string {
  const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  if (bearer) return bearer[1]!;
  const basic = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(authorization);
  if (!basic) throw new DomainError(401, 'Authorization headerが不正です', 'invalid_token');
  if (!isMlflowRequest(request.path))
    throw new DomainError(
      401,
      'Basic認証はMLflow互換APIだけで使えます。Bearer tokenを使ってください',
      'basic_auth_unsupported',
    );
  const credentials = Buffer.from(basic[1]!, 'base64').toString('utf8');
  const separator = credentials.indexOf(':');
  const password = separator < 0 ? '' : credentials.slice(separator + 1);
  if (!API_TOKEN_FORMAT.test(password))
    throw new DomainError(
      401,
      'Basic認証のpasswordにはAPI tokenを指定してください',
      'invalid_token',
    );
  return password;
}

// Without jobTokens (test fixtures that mount only part of the API) Job tokens are rejected.
export function authentication(
  auth: AuthService,
  jobTokens?: JobTokenService,
): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header('Authorization');
    const apiToken = authorization
      ? apiTokenFromAuthorization(authorization, context.req)
      : undefined;
    const session = getCookie(context, SESSION_COOKIE);
    const identity =
      apiToken && isJobToken(apiToken)
        ? await authenticateJobToken(jobTokens, apiToken)
        : await auth.authenticate({ bearer: apiToken, session });
    context.set('principal', identity);
    if (session && !apiToken && !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)) {
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

function authenticateJobToken(jobTokens: JobTokenService | undefined, bearer: string) {
  if (!jobTokens) throw new DomainError(401, 'Job tokenは使用できません', 'invalid_token');
  return jobTokens.authenticate(bearer);
}
