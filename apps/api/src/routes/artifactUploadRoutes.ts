import { Hono } from 'hono';
import { z } from 'zod';
import { MULTIPART_MAX_PART_COUNT } from '@mmt/platform';
import type { ArtifactUploadService } from '../services/artifactUploadService.js';
import { uuidSchema } from '../domain/validation.js';
import { declaredContentLength, requestBodyStream } from '../http/requestBodyStream.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

/** Optional lowercase hex SHA-256 of one part; a mismatch rejects the part without storing it. */
export const PART_SHA256_HEADER = 'X-Part-SHA256';

const sha256Schema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((digest) => digest.toLowerCase());
const uploadCreateSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  runId: uuidSchema.optional(),
  mimeType: z.string().max(255).optional(),
  expectedSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedSha256: sha256Schema.optional(),
  partSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
const uploadListQuerySchema = z.object({
  status: z.enum(['open', 'verifying', 'completed', 'aborted', 'expired', 'failed']).optional(),
});
const partNumberSchema = z.coerce.number().int().min(1).max(MULTIPART_MAX_PART_COUNT);

export function artifactUploadRoutes(uploads: ArtifactUploadService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/artifact-uploads', async (context) =>
    context.json(
      await uploads.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, uploadCreateSchema),
      ),
      201,
    ),
  );
  routes.get('/:p/artifact-uploads', async (context) =>
    context.json({
      items: await uploads.listOwn(
        principal(context),
        uuidParam(context, 'p'),
        parse(uploadListQuerySchema, context.req.query()),
      ),
    }),
  );
  routes.get('/:p/artifact-uploads/:u', async (context) =>
    context.json(
      await uploads.get(principal(context), uuidParam(context, 'p'), uuidParam(context, 'u')),
    ),
  );
  routes.put('/:p/artifact-uploads/:u/parts/:n', async (context) => {
    const declaredSha256 = context.req.header(PART_SHA256_HEADER);
    return context.json(
      await uploads.putPart(principal(context), uuidParam(context, 'p'), {
        uploadId: uuidParam(context, 'u'),
        partNumber: parse(partNumberSchema, context.req.param('n')),
        declaredBytes: declaredContentLength(context),
        sha256: declaredSha256 === undefined ? undefined : parse(sha256Schema, declaredSha256),
        body: requestBodyStream(context),
      }),
    );
  });
  routes.post('/:p/artifact-uploads/:u/complete', async (context) =>
    context.json(
      await uploads.complete(principal(context), uuidParam(context, 'p'), uuidParam(context, 'u')),
      202,
    ),
  );
  routes.delete('/:p/artifact-uploads/:u', async (context) =>
    context.json(
      await uploads.abort(principal(context), uuidParam(context, 'p'), uuidParam(context, 'u')),
    ),
  );
  return routes;
}
