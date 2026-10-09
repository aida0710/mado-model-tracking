import type { z } from 'zod';
import type { ProjectRole, TokenScope } from '@mmt/contracts';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Who may call a route, as the service checks it. OpenAPI shows it per operation
 * (`x-mmt-access`) and derives the generic 401/403 responses from it.
 */
export type RouteAccess =
  // No authentication: health, auth configuration and the login flow.
  | { kind: 'public' }
  // Any signed-in user; an API token also needs `scope`.
  | { kind: 'signedIn'; scope: TokenScope }
  // A browser session of any user (API tokens get 403 session_required).
  | { kind: 'session' }
  // Effective Project role (direct grant or group binding) and, for API tokens, the scope.
  // sessionOnly: API tokens get 403 session_required even with the scope.
  | { kind: 'project'; role: ProjectRole; scope: TokenScope; sessionOnly?: boolean }
  // A global administrator; an API token needs `admin` and no Project restriction.
  | { kind: 'globalAdmin'; sessionOnly?: boolean }
  // A Project-bound API token with `worker:execute` (the worker process, a site's launcher).
  | { kind: 'worker' }
  // The Job token (mmtj_) of the Job in the path: a site's runner, or driver code in the Job.
  | { kind: 'jobToken' }
  // The requester's own API token with `scope`; browser sessions and Job tokens get 403.
  | { kind: 'apiToken'; scope: TokenScope };

/** A body that is not JSON: raw bytes, CSV, a redirect target. */
export interface NonJsonContent {
  contentType: string;
  description: string;
}

export type SuccessStatus = 200 | 201 | 202 | 204 | 206 | 302 | 304;
export type ResponseContent = z.ZodType | NonJsonContent | null;

/** An error the route documents beyond the generic ones its access and input imply. */
export interface RouteError {
  status: number;
  code: string;
}

/**
 * One native route. Paths use the Hono template of the app (`/api/projects/:p/runs/:r`), so the
 * coverage test compares them with `app.routes` without translation.
 */
export interface NativeRoute {
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  access: RouteAccess;
  query?: z.ZodType;
  // Request headers the route reads, as an object schema keyed by header name.
  headers?: z.ZodType;
  body?: z.ZodType | NonJsonContent;
  // A JSON body limit other than MAX_JSON_BODY_BYTES (see requestBodyLimits.ts).
  maxBodyBytes?: number;
  // Body is optional (an empty body means the defaults), as for job retry and alias removal.
  bodyOptional?: boolean;
  responses: Partial<Record<SuccessStatus, ResponseContent>>;
  errors?: readonly RouteError[];
}

export const PROJECT_VIEWER: RouteAccess = { kind: 'project', role: 'viewer', scope: 'read' };
export const PROJECT_ADMIN: RouteAccess = { kind: 'project', role: 'admin', scope: 'admin' };
export const GLOBAL_ADMIN: RouteAccess = { kind: 'globalAdmin' };
export const WORKER: RouteAccess = { kind: 'worker' };
export const JOB_TOKEN: RouteAccess = { kind: 'jobToken' };

export function projectEditor(scope: TokenScope): RouteAccess {
  return { kind: 'project', role: 'editor', scope };
}

export function routeError(status: number, ...codes: string[]): RouteError[] {
  return codes.map((code) => ({ status, code }));
}

export function isNonJsonContent(content: unknown): content is NonJsonContent {
  // zod schemas carry their internals under `_zod`; NonJsonContent is a plain object.
  return (
    typeof content === 'object' &&
    content !== null &&
    'contentType' in content &&
    !('_zod' in content)
  );
}
