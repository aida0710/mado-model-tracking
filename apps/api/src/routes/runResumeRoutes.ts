import { Hono } from 'hono';
import { runResumeRequestSchema } from '../domain/runResume.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { RunResumeService } from '../services/runResumeService.js';

export function runResumeRoutes(runResumes: RunResumeService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/runs/:r/resume', async (context) => {
    const { reason } = await jsonBody(context, runResumeRequestSchema);
    return context.json(
      await runResumes.resume(
        principal(context),
        { projectId: uuidParam(context, 'p'), runId: uuidParam(context, 'r'), reason },
        requestMetadata(context),
      ),
    );
  });
  routes.get('/:p/runs/:r/resume-events', async (context) =>
    context.json(
      await runResumes.listEvents(principal(context), {
        projectId: uuidParam(context, 'p'),
        runId: uuidParam(context, 'r'),
      }),
    ),
  );
  return routes;
}
