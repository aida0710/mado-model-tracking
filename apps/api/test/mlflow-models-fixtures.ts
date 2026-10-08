import { Hono } from 'hono';
import type { Run } from '@mmt/contracts';
import { DomainError } from '../src/domain/errors.js';
import { authentication } from '../src/http/authMiddleware.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { mlflowModelRoutes } from '../src/mlflow/models/index.js';
import { mlflowArtifactRoutes } from '../src/mlflow/artifacts/index.js';
import { mlflowTrackingRoutes } from '../src/mlflow/tracking/index.js';
import { entity, request, type Harness } from './harness.js';
import { projectFixture } from './fixtures.js';

export interface LoggedModelResponse {
  model: {
    info: {
      model_id: string;
      experiment_id: string;
      name: string;
      artifact_uri: string;
      status: string;
      source_run_id?: string;
      tags: { key: string; value: string }[];
    };
    data: {
      params: { key: string; value: string }[];
      metrics: {
        key: string;
        value: number;
        run_id: string;
        dataset_name?: string;
        dataset_digest?: string;
      }[];
    };
  };
}
export interface VersionResponse {
  model_version: {
    name: string;
    version: string;
    source: string;
    run_id: string;
    model_id: string;
    aliases: string[];
    description: string;
    current_stage: string;
    tags: { key: string; value: string }[];
  };
}

export async function modelFixture(harness: Harness) {
  const fixture = await projectFixture(harness);
  const app = new Hono<ApiEnvironment>();
  app.onError((error, context) => {
    if (error instanceof DomainError)
      return context.json({ error: error.message, code: error.code }, error.status);
    const code = (error as { code?: string }).code;
    if (code === '23505') return context.json({ error: 'Duplicate', code: 'already_exists' }, 409);
    if (code === '23514' || code === '23503')
      return context.json({ error: 'Invalid reference', code: 'invalid_reference' }, 422);
    throw error;
  });
  app.use('*', authentication(harness.services.auth));
  const base = `/api/mlflow/projects/${fixture.project.id}`;
  app.route(
    '/api/mlflow/projects/:p',
    mlflowModelRoutes({ database: harness.database, registry: harness.services.registry }),
  );
  app.route(
    '/api/mlflow/projects/:p',
    mlflowArtifactRoutes({ database: harness.database, artifacts: harness.services.artifacts }),
  );
  app.route(
    '/api/mlflow/projects/:p',
    mlflowTrackingRoutes({
      database: harness.database,
      runs: harness.services.runs,
      registry: harness.services.registry,
      runCompletion: harness.services.runCompletion,
    }),
  );
  const run = await entity<Run>(
    await request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { experimentId: fixture.experiment.id, name: 'Model source', kind: 'training' },
    }),
  );
  const modelEndpoint = `${base}/api/2.0/mlflow/logged-models`;
  const registryEndpoint = `${base}/api/2.0/mlflow/registered-models`;
  const versionEndpoint = `${base}/api/2.0/mlflow/model-versions`;
  async function createLogged(
    options: {
      name?: string;
      tags?: { key: string; value: string }[];
      params?: { key: string; value: string }[];
      sourceRunId?: string;
    } = {},
  ) {
    return entity<LoggedModelResponse>(
      await request(app, modelEndpoint, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experiment_id: fixture.experiment.id,
          source_run_id: options.sourceRunId ?? run.id,
          name: options.name ?? 'sklearn-model',
          tags: options.tags ?? [],
          params: options.params ?? [],
        },
      }),
      200,
    );
  }
  async function upload(modelId: string, path: string, contents: string) {
    return request(
      app,
      `${base}/api/2.0/mlflow-artifacts/artifacts/models/${modelId}/artifacts/${path}`,
      {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: contents,
      },
    );
  }
  async function finalize(modelId: string, status = 'LOGGED_MODEL_READY') {
    return request(app, `${modelEndpoint}/${modelId}`, {
      method: 'PATCH',
      cookie: fixture.editor.cookie,
      body: { model_id: modelId, status },
    });
  }
  async function readyModel(
    options: { name?: string; tags?: { key: string; value: string }[]; weights?: string } = {},
  ) {
    const created = await createLogged(options);
    const modelId = created.model.info.model_id;
    const files = {
      MLmodel:
        'flavors:\n  sklearn:\n    pickled_model: model.pkl\n  python_function:\n    loader_module: mlflow.sklearn\n    model_path: model.pkl\n',
      'model.pkl': options.weights ?? 'model-weights',
      'requirements.txt': 'scikit-learn==1.9.1\n',
      'python_env.yaml': 'python: 3.13\n',
    };
    for (const [path, contents] of Object.entries(files))
      await entity(await upload(modelId, path, contents), 200);
    return entity<LoggedModelResponse>(await finalize(modelId), 200);
  }
  async function createRegistered(
    name = 'Classifier',
    tags: { key: string; value: string }[] = [],
  ) {
    return request(app, `${registryEndpoint}/create`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { name, tags },
    });
  }
  async function register(
    modelId: string,
    options: {
      name?: string;
      tags?: { key: string; value: string }[];
      runId?: string;
      source?: string;
    } = {},
  ) {
    return request(app, `${versionEndpoint}/create`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        name: options.name ?? 'Classifier',
        source: options.source ?? `models:/${modelId}`,
        model_id: modelId,
        tags: options.tags ?? [],
        ...(options.runId ? { run_id: options.runId } : {}),
      },
    });
  }
  return {
    ...fixture,
    app,
    base,
    run,
    modelEndpoint,
    registryEndpoint,
    versionEndpoint,
    createLogged,
    upload,
    finalize,
    readyModel,
    createRegistered,
    register,
  };
}
export type ModelFixture = Awaited<ReturnType<typeof modelFixture>>;
