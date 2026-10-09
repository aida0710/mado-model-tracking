import { jobTokenAccessOf } from '../jobTokenGuard.js';
import { isNonJsonContent, routeError, type NativeRoute, type RouteError } from './nativeRoute.js';

/**
 * Errors every route of a kind can return, derived from its access, its input and the shared
 * middleware (app.ts, authMiddleware.ts, jobTokenGuard.ts), so the catalog lists only the
 * errors particular to a route.
 */
export function genericErrorsOf(route: NativeRoute): RouteError[] {
  const errors: RouteError[] = [];
  const { access } = route;
  const usesInput =
    route.body !== undefined || route.query !== undefined || route.path.includes(':');
  if (route.body !== undefined && !isNonJsonContent(route.body))
    errors.push(...routeError(400, 'invalid_json'), ...routeError(413, 'body_too_large'));
  if (usesInput) errors.push(...routeError(422, 'invalid_request'));
  if (access.kind !== 'public') {
    errors.push(
      ...routeError(401, 'authentication_required', 'invalid_token', 'basic_auth_unsupported'),
    );
    errors.push(...routeError(403, 'password_change_required'));
    if (route.method !== 'get') errors.push(...routeError(403, 'invalid_origin'));
    // An SSO session is rechecked against the IdP's UserInfo; an unreachable IdP fails closed.
    errors.push(...routeError(503, 'oidc_unavailable'));
  }
  const isSessionOnly = access.kind === 'session' || ('sessionOnly' in access && access.sessionOnly);
  if (isSessionOnly) errors.push(...routeError(403, 'session_required'));
  // An SSO user's API token stops when the user's group sync is older than the allowed age.
  else if (access.kind !== 'public') errors.push(...routeError(401, 'identity_sync_required'));
  if (access.kind === 'signedIn' || access.kind === 'project' || access.kind === 'globalAdmin')
    errors.push(...routeError(403, 'insufficient_scope'));
  if (access.kind === 'project')
    errors.push(...routeError(403, 'project_forbidden'), ...routeError(404, 'not_found'));
  if (access.kind === 'globalAdmin') errors.push(...routeError(403, 'admin_required'));
  if (access.kind === 'worker') errors.push(...routeError(403, 'worker_token_required'));
  if (access.kind === 'apiToken')
    errors.push(...routeError(403, 'api_token_required', 'insufficient_scope'));
  if (access.kind !== 'public' && jobTokenAccess(route) !== 'read')
    errors.push(...routeError(403, 'job_token_forbidden'));
  if (route.method !== 'get')
    errors.push(...routeError(409, 'already_exists'), ...routeError(422, 'invalid_reference'));
  errors.push(...routeError(503, 'internal_error'));
  return errors;
}

/** Route-specific errors first, then the generic ones, without repeating a status and code. */
export function errorsOf(route: NativeRoute): RouteError[] {
  const seen = new Set<string>();
  return [...(route.errors ?? []), ...genericErrorsOf(route)].filter((error) => {
    const key = `${error.status} ${error.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * How a Job token (mmtj_) reaches the route: 'read' and 'write' follow the guard's allow lists
 * ('write' still requires the token's own Run), null means 403 job_token_forbidden.
 */
export function jobTokenAccess(route: NativeRoute): 'read' | 'write' | null {
  if (route.access.kind === 'public' || route.access.kind === 'session') return null;
  return jobTokenAccessOf(route.method.toUpperCase(), route.path);
}
