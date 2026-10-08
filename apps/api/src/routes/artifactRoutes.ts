import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ArtifactService } from '../services/artifactService.js';
import { requestBodyStream } from '../http/requestBodyStream.js';
import {
  artifactContentHeaders,
  artifactValidatorHeaders,
  IMMUTABLE_ARTIFACT_CACHE_CONTROL,
  matchesIfNoneMatch,
  shouldServeRange,
} from '../http/artifactContentHeaders.js';
import {
  parse,
  principal,
  uuidParam,
  type ApiEnvironment,
  type ApiContext,
} from '../http/request.js';

// Bound project catalogs while leaving room for uploaded SIF files and model weights.
const DEFAULT_CATALOG_LIMIT = 100;
const MAX_CATALOG_LIMIT = 500;
const artifactCatalogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CATALOG_LIMIT).default(DEFAULT_CATALOG_LIMIT),
  query: z.string().trim().max(200).optional(),
});

function declaredContentLength(context: ApiContext): number | undefined {
  const header = context.req.header('Content-Length');
  return header && /^\d+$/.test(header) ? Number(header) : undefined;
}

/**
 * Earlier middleware has already materialized the response (CORS) and set the API-wide no-store,
 * and Hono copies those headers over a returned Response. Setting them on the context wins.
 */
function setResponseHeaders(context: ApiContext, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) context.header(name, value);
}

export function artifactRoutes(artifacts: ArtifactService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  const upload = async (context: ApiContext, runId?: string) => {
    return context.json(
      await artifacts.upload(principal(context), uuidParam(context, 'p'), {
        runId,
        path: context.req.query('path') ?? '',
        mimeType: context.req.header('Content-Type'),
        declaredBytes: declaredContentLength(context),
        body: requestBodyStream(context),
      }),
      201,
    );
  };
  routes.get('/:p/runs/:r/artifacts', async (context) =>
    context.json({
      items: await artifacts.list(
        principal(context),
        uuidParam(context, 'p'),
        uuidParam(context, 'r'),
      ),
    }),
  );
  routes.put('/:p/runs/:r/artifacts', (context) => upload(context, uuidParam(context, 'r')));
  routes.get('/:p/artifacts', async (context) =>
    context.json({
      items: await artifacts.listProject(
        principal(context),
        uuidParam(context, 'p'),
        parse(artifactCatalogQuerySchema, context.req.query()),
      ),
    }),
  );
  routes.put('/:p/artifacts', (context) => upload(context));
  routes.get('/:p/artifacts/:a', async (context) =>
    context.json(
      await artifacts.getMetadata(
        principal(context),
        uuidParam(context, 'p'),
        uuidParam(context, 'a'),
      ),
    ),
  );
  routes.get('/:p/artifacts/:a/content', async (context) => {
    const artifact = await artifacts.getMetadata(
      principal(context),
      uuidParam(context, 'p'),
      uuidParam(context, 'a'),
    );
    if (matchesIfNoneMatch(context.req.header('If-None-Match'), artifact)) {
      setResponseHeaders(
        context,
        artifactValidatorHeaders(artifact, IMMUTABLE_ARTIFACT_CACHE_CONTROL),
      );
      return context.body(null, 304);
    }
    const range = shouldServeRange(context.req.header('If-Range'), artifact)
      ? context.req.header('Range')
      : undefined;
    const content = await artifacts.readContent(artifact, range);
    setResponseHeaders(
      context,
      artifactContentHeaders({
        artifact,
        content,
        disposition: 'inline-when-safe',
        cacheControl: IMMUTABLE_ARTIFACT_CACHE_CONTROL,
      }),
    );
    return context.body(Readable.toWeb(content.body) as ReadableStream<Uint8Array>, content.status);
  });
  return routes;
}
