import { Hono } from 'hono';
import {
  jobArrayCreateSchema,
  manualSubmissionClaimSchema,
  manualSubmissionReportSchema,
  runnerFinishSchema,
  runnerHeartbeatSchema,
  runnerLogsSchema,
  runnerMetricsSchema,
  runnerOutputsSchema,
  runnerStartSchema,
} from '../domain/siteExecutionValidation.js';
import { jsonBody, principal, uuidParam, type ApiContext, type ApiEnvironment } from '../http/request.js';
import type { JobArrayService } from '../services/jobArrayService.js';
import type { RunnerService } from '../services/runnerService.js';
import type { SiteSubmissionService } from '../services/siteSubmissionService.js';

function jobReference(context: ApiContext) {
  return { projectId: uuidParam(context, 'p'), jobId: uuidParam(context, 'j') };
}

// Mounted at /api/projects.
export function jobArrayRoutes(arrays: JobArrayService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/job-arrays', async (context) =>
    context.json(
      await arrays.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, jobArrayCreateSchema),
      ),
      201,
    ),
  );
  routes.get('/:p/job-arrays/:g', async (context) =>
    context.json(
      await arrays.get(principal(context), uuidParam(context, 'p'), uuidParam(context, 'g')),
    ),
  );
  return routes;
}

// Mounted at /api: `mado-tracking submit` with the requester's own API token.
export function manualSubmissionRoutes(submissions: SiteSubmissionService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/manual-submissions', async (context) =>
    context.json({ items: await submissions.listManual(principal(context)) }),
  );
  routes.get('/manual-submissions/sites/:targetId', async (context) =>
    context.json(
      await submissions.manualConfiguration(principal(context), uuidParam(context, 'targetId')),
    ),
  );
  routes.post('/manual-submissions/claim', async (context) =>
    context.json({
      items: await submissions.claimManual(
        principal(context),
        await jsonBody(context, manualSubmissionClaimSchema),
      ),
    }),
  );
  routes.post('/manual-submissions/report', async (context) =>
    context.json({
      items: await submissions.reportManual(
        principal(context),
        await jsonBody(context, manualSubmissionReportSchema),
      ),
    }),
  );
  return routes;
}

// Mounted at /api/projects: the runner on a site's compute node, with its Job token.
export function runnerRoutes(runner: RunnerService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/jobs/:j/runner/start', async (context) =>
    context.json(
      await runner.start(
        principal(context),
        jobReference(context),
        await jsonBody(context, runnerStartSchema),
      ),
    ),
  );
  routes.post('/:p/jobs/:j/runner/heartbeat', async (context) =>
    context.json(
      await runner.heartbeat(
        principal(context),
        jobReference(context),
        await jsonBody(context, runnerHeartbeatSchema),
      ),
    ),
  );
  routes.post('/:p/jobs/:j/runner/logs', async (context) => {
    await runner.logs(
      principal(context),
      jobReference(context),
      await jsonBody(context, runnerLogsSchema),
    );
    return context.body(null, 204);
  });
  routes.post('/:p/jobs/:j/runner/metrics', async (context) => {
    await runner.metrics(
      principal(context),
      jobReference(context),
      await jsonBody(context, runnerMetricsSchema),
    );
    return context.body(null, 204);
  });
  routes.post('/:p/jobs/:j/runner/outputs', async (context) =>
    context.json({
      items: await runner.outputs(
        principal(context),
        jobReference(context),
        await jsonBody(context, runnerOutputsSchema),
      ),
    }),
  );
  routes.post('/:p/jobs/:j/runner/finish', async (context) =>
    context.json(
      await runner.finish(
        principal(context),
        jobReference(context),
        await jsonBody(context, runnerFinishSchema),
      ),
    ),
  );
  return routes;
}
