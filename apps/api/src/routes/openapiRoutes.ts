import { Hono } from 'hono';
import {
  buildOpenApiDocument,
  type OpenApiDocument,
} from '../http/openapi/buildOpenApiDocument.js';
import { principal, type ApiEnvironment } from '../http/request.js';
import { requireScope } from '../services/accessService.js';

// Mounted at /api: GET /openapi.json serves the native API document to any signed-in user.
export function openapiRoutes(): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  // The catalog does not change while the process runs, so the document is built once.
  let document: OpenApiDocument | undefined;
  routes.get('/openapi.json', (context) => {
    requireScope(principal(context), 'read');
    document ??= buildOpenApiDocument();
    return context.json(document);
  });
  return routes;
}
