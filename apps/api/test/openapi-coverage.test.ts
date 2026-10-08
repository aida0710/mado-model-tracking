import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { IssuedToken } from '../src/services/tokenService.js';
import type { issuedTokenSchema } from '@mmt/contracts/schemas';
import type { z } from 'zod';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  buildOpenApiDocument,
  formatOpenApiDocument,
  openApiPath,
} from '../src/http/openapi/buildOpenApiDocument.js';
import { errorsOf } from '../src/http/openapi/operationErrors.js';
import { NATIVE_ROUTES } from '../src/http/openapi/routeCatalog.js';

const CONTRACT_DOCUMENT = new URL('../../../docs/api-contract.md', import.meta.url);
const GENERATED_DOCUMENT = new URL('../../../docs/openapi.json', import.meta.url);
// Never connected: building the app only reads the route table. The loopback port is closed.
const UNREACHABLE_DATABASE_URL = 'postgresql://mmt@127.0.0.1:1/mmt_unreachable';

// Documented in api-contract.md but implemented by a route of the same wave that is not merged
// into this branch yet. The parent removes an entry when it adds the route to the catalog.
const DOCUMENTED_ROUTES_PENDING_IMPLEMENTATION = new Set<string>();
// Codes the contract names that no native route returns (MLflow responses, worker-side checks).
const DOCUMENTED_CODES_OUTSIDE_NATIVE_ROUTES = new Set([
  // Returned through the MLflow Artifact API in its own error format.
  '409 checkpoint_finalized',
]);

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// The API's IssuedToken (not a contracts type) has the shape the document publishes.
const issuedTokenMatches: MutuallyAssignable<IssuedToken, z.infer<typeof issuedTokenSchema>> = true;

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function applicationRoutes(): Set<string> {
  const database = new pg.Pool({ connectionString: UNREACHABLE_DATABASE_URL });
  const config = loadConfig({
    MMT_DATABASE_URL: UNREACHABLE_DATABASE_URL,
    AUTH_MODE: 'development',
  });
  const { app } = createApplication({ config, database, environment: {} });
  return new Set(
    app.routes
      // Middleware registrations (app.use) appear with method ALL.
      .filter((route) => route.method !== 'ALL' && !route.path.startsWith('/api/mlflow/'))
      .map((route) => routeKey(route.method, route.path)),
  );
}

/** `/projects/:p/runs/:runId?x=` → `/projects/{}/runs/{}`, so the doc's parameter names do not matter. */
function normalizedPath(path: string): string {
  return path
    .replace(/[?#].*$/, '')
    .replace(/[),.;]+$/, '')
    .replace(/:[A-Za-z_]+|\{[A-Za-z_]+\}/g, '{}');
}

/** Route mentions in docs/api-contract.md such as `GET /projects/:p/runs` or `GET/POST /x`. */
function documentedRoutes(contract: string): Set<string> {
  const mentions = new Set<string>();
  for (const [, methods, path] of contract.matchAll(
    /`((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*) (\/[^`\s]*)/g,
  )) {
    // MLflow paths (/api/2.0/..., /api/3.0/..., /server-info) belong to the MLflow section.
    if (/^\/(api\/[23]\.0|server-info)/.test(path!)) continue;
    for (const method of methods!.split('/')) mentions.add(`${method} ${normalizedPath(path!)}`);
  }
  return mentions;
}

/** `409 \`run_finalized\``: a status and a code the contract promises somewhere. */
function documentedErrors(contract: string): Set<string> {
  const native = contract.split(/^## /m).filter((section) => !section.startsWith('MLflow'));
  return new Set(
    native.flatMap((section) =>
      [...section.matchAll(/(\d{3})\s*`([a-z][a-z0-9_]*)`/g)].map(
        ([, status, code]) => `${status} ${code}`,
      ),
    ),
  );
}

function collectRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) value.forEach((item) => collectRefs(item, refs));
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') refs.add(item);
      else collectRefs(item, refs);
    }
}

describe('OpenAPI document of the native API', () => {
  it('declares exactly the native routes the application serves', () => {
    expect(issuedTokenMatches).toBe(true);
    const served = applicationRoutes();
    const declared = new Set(NATIVE_ROUTES.map((route) => routeKey(route.method, route.path)));
    expect([...served].filter((route) => !declared.has(route)).sort()).toEqual([]);
    expect([...declared].filter((route) => !served.has(route)).sort()).toEqual([]);
  });

  it('puts the worker protocol under its own tag', () => {
    for (const route of NATIVE_ROUTES)
      expect(route.tag === 'worker', `${route.method} ${route.path}`).toBe(
        route.path.startsWith('/api/worker/'),
      );
  });

  it('covers every route and error code that docs/api-contract.md documents', async () => {
    const contract = await readFile(CONTRACT_DOCUMENT, 'utf8');
    const declaredPaths = NATIVE_ROUTES.map((route) => ({
      method: route.method.toUpperCase(),
      path: normalizedPath(route.path.replace(/^\/api(?=\/)/, '')),
    }));
    // The contract writes paths without /api and sometimes only their tail (`POST /runs/search`).
    const undeclared = [...documentedRoutes(contract)].filter((mention) => {
      const [method, path] = mention.split(' ');
      return (
        !DOCUMENTED_ROUTES_PENDING_IMPLEMENTATION.has(mention) &&
        !declaredPaths.some(
          (route) => route.method === method && (route.path === path || route.path.endsWith(path!)),
        )
      );
    });
    expect(undeclared.sort()).toEqual([]);

    const declaredErrors = new Set(
      NATIVE_ROUTES.flatMap((route) => errorsOf(route)).map(
        ({ status, code }) => `${status} ${code}`,
      ),
    );
    const missing = [...documentedErrors(contract)].filter(
      (error) => !declaredErrors.has(error) && !DOCUMENTED_CODES_OUTSIDE_NATIVE_ROUTES.has(error),
    );
    expect(missing.sort()).toEqual([]);
  });

  it('declares only route-specific error codes that docs/api-contract.md mentions', async () => {
    const contract = await readFile(CONTRACT_DOCUMENT, 'utf8');
    const undocumented = NATIVE_ROUTES.flatMap((route) =>
      (route.errors ?? [])
        .filter(({ code }) => !contract.includes(`\`${code}\``))
        .map(({ status, code }) => `${route.method} ${route.path}: ${status} ${code}`),
    );
    expect(undocumented).toEqual([]);
  });

  it('builds a document whose references resolve and whose operations are unique', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    const refs = new Set<string>();
    collectRefs(document, refs);
    const unresolved = [...refs].filter(
      (ref) => !(ref.replace('#/components/schemas/', '') in document.components.schemas),
    );
    expect(unresolved).toEqual([]);
    const operationIds = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => (operation as { operationId: string }).operationId),
    );
    expect(new Set(operationIds).size).toBe(NATIVE_ROUTES.length);
    expect(Object.keys(document.paths)).toContain(openApiPath('/api/projects/:p/runs/:r'));
  });

  it('marks Job-token access from the guard and documents the body limit exceptions', () => {
    const document = buildOpenApiDocument();
    const operation = (path: string, method: string) =>
      document.paths[openApiPath(path)]![method] as Record<string, unknown> & {
        requestBody?: Record<string, unknown>;
      };
    expect(operation('/api/projects/:p/runs/:r/metrics', 'post')['x-mmt-job-token']).toBe('write');
    expect(operation('/api/projects/:p/runs/search', 'post')['x-mmt-job-token']).toBe('read');
    expect(operation('/api/projects/:p/runs', 'post')['x-mmt-job-token']).toBe('forbidden');
    expect(operation('/api/worker/claim', 'post')['x-mmt-job-token']).toBe('forbidden');
    expect(
      operation('/api/projects/:p/sync/runs/:r/batches', 'post').requestBody?.[
        'x-mmt-max-body-bytes'
      ],
    ).toBe(32 * 1024 * 1024);
    expect(
      operation('/api/projects/:p/datasets/:id/versions', 'post').requestBody?.[
        'x-mmt-max-body-bytes'
      ],
    ).toBe(128 * 1024 * 1024);
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      'bearerToken',
      'mlflowBasic',
      'sessionCookie',
    ]);
  });

  it('matches the committed docs/openapi.json (run npm run openapi:generate after changes)', async () => {
    const committed = await readFile(GENERATED_DOCUMENT, 'utf8');
    expect(committed === formatOpenApiDocument(buildOpenApiDocument())).toBe(true);
  });
});
