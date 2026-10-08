import type { Run } from '@mmt/contracts';
import { ArtifactRangeError } from '@mmt/platform';
import { Hono } from 'hono';
import { DomainError } from '../src/domain/errors.js';
import { authentication } from '../src/http/authMiddleware.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { mlflowArtifactRoutes } from '../src/mlflow/artifacts/index.js';
import { ArtifactService } from '../src/services/artifactService.js';
import { projectFixture } from './fixtures.js';
import { entity, request, type Harness } from './harness.js';

export function createArtifactTestApp(
  harness: Harness,
  artifacts: ArtifactService = harness.services.artifacts,
) {
  const app = new Hono<ApiEnvironment>();
  app.onError((error, context) => {
    if (error instanceof DomainError)
      return context.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof ArtifactRangeError) {
      context.header('Content-Range', `bytes */${error.totalSize}`);
      return context.json({ code: 'invalid_range' }, 416);
    }
    throw error;
  });
  app.use('/api/*', authentication(harness.services.auth));
  app.route(
    '/api/mlflow/projects/:p',
    mlflowArtifactRoutes({ database: harness.database, artifacts }),
  );
  return app;
}

export async function artifactFixture(harness: Harness) {
  const fixture = await projectFixture(harness);
  const run = await entity<Run>(
    await request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { experimentId: fixture.experiment.id, name: 'Artifact Run', kind: 'training' },
    }),
  );
  const mlflowPath = `/api/mlflow/projects/${fixture.project.id}`;
  const runRoot = `runs/${run.id}/artifacts`;
  const app = createArtifactTestApp(harness);
  async function loggedModel(options: { sourceRun?: boolean } = {}) {
    const {
      rows: [model],
    } = await harness.database.query<{ id: string }>(
      `INSERT INTO mlflow_logged_models(id,project_id,experiment_id,source_run_id,name,created_by)
       VALUES('m-'||replace(gen_random_uuid()::text,'-',''),$1,$2,$3,'Artifact Model',$4) RETURNING id`,
      [
        fixture.project.id,
        fixture.experiment.id,
        options.sourceRun === false ? null : run.id,
        fixture.editor.userId,
      ],
    );
    return { id: model!.id, root: `models/${model!.id}/artifacts` };
  }
  return { ...fixture, run, mlflowPath, runRoot, app, loggedModel };
}

export function transferUrl(mlflowPath: string, ownerRoot: string, path: string): string {
  return `${mlflowPath}/api/2.0/mlflow-artifacts/artifacts/${ownerRoot}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function proxyListUrl(mlflowPath: string, path: string): string {
  return `${mlflowPath}/api/2.0/mlflow-artifacts/artifacts?path=${encodeURIComponent(path)}`;
}

export function artifactServiceDuringWrite(
  harness: Harness,
  afterStored: () => Promise<void>,
): ArtifactService {
  return new ArtifactService(harness.database, {
    ...harness.stores,
    async put(write) {
      const stored = await harness.stores.put(write);
      await afterStored();
      return stored;
    },
  });
}
