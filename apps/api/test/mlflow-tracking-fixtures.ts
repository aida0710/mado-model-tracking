import { Hono } from 'hono';
import { DomainError } from '../src/domain/errors.js';
import { authentication } from '../src/http/authMiddleware.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { mlflowTrackingRoutes } from '../src/mlflow/tracking/index.js';
import type { serializeRun } from '../src/mlflow/tracking/trackingSerialization.js';
import { entity, request, type Harness } from './harness.js';
import type { projectFixture } from './fixtures.js';

export type WireRun = Awaited<ReturnType<typeof serializeRun>>;
export function trackingTestApp(harness: Harness) {
  const app = new Hono<ApiEnvironment>();
  app.onError((error, context) => {
    if (error instanceof DomainError)
      return context.json({ error: error.message, code: error.code }, error.status);
    throw error;
  });
  app.use('*', authentication(harness.services.auth));
  app.route(
    '/api/mlflow/projects/:p',
    mlflowTrackingRoutes({
      database: harness.database,
      runs: harness.services.runs,
      registry: harness.services.registry,
    }),
  );
  return app;
}
export function trackingClient(
  app: Hono<ApiEnvironment>,
  fixture: Awaited<ReturnType<typeof projectFixture>>,
) {
  const base = `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow`;
  const post = (endpoint: string, body: unknown, cookie = fixture.editor.cookie) =>
    request(app, `${base}${endpoint}`, { method: 'POST', cookie, body });
  const get = (endpoint: string, query: Record<string, string>, cookie = fixture.editor.cookie) =>
    request(app, `${base}${endpoint}?${new URLSearchParams(query)}`, { cookie });
  const createRun = async (input: Record<string, unknown> = {}): Promise<WireRun> => {
    const response = await post('/runs/create', { experiment_id: fixture.experiment.id, ...input });
    return (await entity<{ run: WireRun }>(response, 200)).run;
  };
  const getRun = async (runId: string): Promise<WireRun> =>
    (await entity<{ run: WireRun }>(await get('/runs/get', { run_id: runId }), 200)).run;
  return { base, post, get, createRun, getRun };
}
