import { Hono } from 'hono';
import {
  artifactPresenceCheckSchema,
  syncBatchSchema,
  syncRunCreateSchema,
} from '../domain/runSyncValidation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { RunSyncService } from '../services/runSyncService.js';

export function runSyncRoutes(runSync: RunSyncService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.put('/:p/sync/runs/:r', async (context) => {
    const input = await jsonBody(context, syncRunCreateSchema);
    const { run, created } = await runSync.createRun(
      principal(context),
      {
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
        input,
      },
      requestMetadata(context),
    );
    return context.json(run, created ? 201 : 200);
  });
  routes.post('/:p/sync/runs/:r/batches', async (context) => {
    const batch = await jsonBody(context, syncBatchSchema);
    return context.json(
      await runSync.applyBatch(principal(context), {
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
        batch,
      }),
    );
  });
  routes.post('/:p/sync/runs/:r/artifacts/check', async (context) => {
    const check = await jsonBody(context, artifactPresenceCheckSchema);
    return context.json(
      await runSync.checkArtifacts(principal(context), {
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
        check,
      }),
    );
  });
  return routes;
}
