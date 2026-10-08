import { Hono } from 'hono';
import { z } from 'zod';
import { ARTIFACT_MEDIA_INFO_BATCH_LIMIT } from '@mmt/contracts';
import { uuidSchema } from '../domain/validation.js';
import { parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { ArtifactMediaInfoService } from '../services/artifactMediaInfoService.js';

// artifactIds is one comma-separated value so a sample table fits its whole page in one URL.
const artifactMediaInfoQuerySchema = z.object({
  artifactIds: z
    .string()
    .optional()
    .transform((value) => [...new Set(value ? value.split(',') : [])])
    .pipe(z.array(uuidSchema).max(ARTIFACT_MEDIA_INFO_BATCH_LIMIT)),
});

export function artifactMediaInfoRoutes(mediaInfo: ArtifactMediaInfoService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/artifacts/:a/media-info', async (context) =>
    context.json(
      await mediaInfo.get(principal(context), {
        projectId: uuidParam(context, 'p'),
        artifactId: uuidParam(context, 'a'),
      }),
    ),
  );
  routes.get('/:p/artifact-media-info', async (context) => {
    const { artifactIds } = parse(artifactMediaInfoQuerySchema, context.req.query());
    return context.json({
      items: await mediaInfo.list(principal(context), {
        projectId: uuidParam(context, 'p'),
        artifactIds,
      }),
    });
  });
  return routes;
}
