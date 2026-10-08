import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ArtifactService } from '../services/artifactService.js';
import {
  parse,
  principal,
  uuidParam,
  type ApiEnvironment,
  type ApiContext,
} from '../http/request.js';

const safeInlineMimeTypes = new Set([
  'text/plain',
  'application/json',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/ogg',
  'video/mp4',
  'video/webm',
]);

// Bound project catalogs while leaving room for uploaded SIF files and model weights.
const DEFAULT_CATALOG_LIMIT = 100;
const MAX_CATALOG_LIMIT = 500;
const artifactCatalogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CATALOG_LIMIT).default(DEFAULT_CATALOG_LIMIT),
  query: z.string().trim().max(200).optional(),
});

export function artifactRoutes(artifacts: ArtifactService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  const upload = async (context: ApiContext, runId?: string) => {
    const requestBody = context.req.raw.body;
    const body = requestBody
      ? Readable.fromWeb(requestBody as import('node:stream/web').ReadableStream<Uint8Array>)
      : Readable.from([]);
    return context.json(
      await artifacts.upload(principal(context), uuidParam(context, 'p'), {
        runId,
        path: context.req.query('path') ?? '',
        mimeType: context.req.header('Content-Type') ?? 'application/octet-stream',
        body,
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
    const { artifact, content } = await artifacts.content(
      principal(context),
      uuidParam(context, 'p'),
      { artifactId: uuidParam(context, 'a'), range: context.req.header('Range') },
    );
    const mimeType = artifact.mimeType.split(';')[0]!.toLowerCase();
    const disposition = safeInlineMimeTypes.has(mimeType) ? 'inline' : 'attachment';
    const filename = artifact.path.split('/').at(-1)!;
    const headers: Record<string, string> = {
      'Content-Type': artifact.mimeType,
      'Content-Length': String(content.size),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store',
    };
    if (content.contentRange) headers['Content-Range'] = content.contentRange;
    return new Response(Readable.toWeb(content.body) as ReadableStream<Uint8Array>, {
      status: content.status,
      headers,
    });
  });
  return routes;
}
