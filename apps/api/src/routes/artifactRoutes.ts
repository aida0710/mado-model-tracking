import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import { uuidSchema } from '../domain/validation.js';
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
// A Run page holds one browser directory level; clients that need every file follow nextCursor.
const DEFAULT_RUN_ARTIFACT_LIMIT = 1000;
const MAX_RUN_ARTIFACT_LIMIT = 1000;
// Same bound as stored Artifact paths (artifactRegistration), so any stored directory can be a prefix.
const MAX_PREFIX_LENGTH = 1024;
// Cursors are base64url JSON holding one path, so they stay below a few kilobytes.
const MAX_CURSOR_LENGTH = 4096;
const versionsSchema = z.enum(['latest', 'all']);
const cursorSchema = z.string().max(MAX_CURSOR_LENGTH).optional();
export const artifactCatalogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CATALOG_LIMIT).default(DEFAULT_CATALOG_LIMIT),
  query: z.string().trim().max(200).optional(),
  cursor: cursorSchema,
  mimeType: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/i)
    .optional(),
  runId: uuidSchema.optional(),
  modelVersionId: uuidSchema.optional(),
  // The catalog listed every upload before versions existed; keep that as the default.
  versions: versionsSchema.default('all'),
});
export const runArtifactQuerySchema = z.object({
  prefix: z.string().max(MAX_PREFIX_LENGTH).default(''),
  delimiter: z.literal('/').optional(),
  versions: versionsSchema.default('latest'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_RUN_ARTIFACT_LIMIT)
    .default(DEFAULT_RUN_ARTIFACT_LIMIT),
  cursor: cursorSchema,
});
export const artifactTreeQuerySchema = z.object({
  prefix: z.string().max(MAX_PREFIX_LENGTH).default(''),
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
  routes.get('/:p/runs/:r/artifacts', async (context) => {
    const { delimiter, ...query } = parse(runArtifactQuerySchema, context.req.query());
    return context.json(
      await artifacts.list(principal(context), {
        ...query,
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
        directFilesOnly: delimiter === '/',
      }),
    );
  });
  routes.get('/:p/runs/:r/artifacts/tree', async (context) =>
    context.json(
      await artifacts.tree(principal(context), {
        ...parse(artifactTreeQuerySchema, context.req.query()),
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
      }),
    ),
  );
  routes.put('/:p/runs/:r/artifacts', (context) => upload(context, uuidParam(context, 'r')));
  routes.get('/:p/artifacts', async (context) =>
    context.json(
      await artifacts.listProject(principal(context), {
        ...parse(artifactCatalogQuerySchema, context.req.query()),
        projectId: uuidParam(context, 'p'),
      }),
    ),
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
