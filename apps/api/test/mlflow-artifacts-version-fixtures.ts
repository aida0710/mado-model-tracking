import { mlflowModelRoutes } from '../src/mlflow/models/index.js';
import { artifactFixture, transferUrl } from './mlflow-artifacts-fixtures.js';
import { entity, request, type Harness } from './harness.js';

export async function registeredVersionFixture(harness: Harness, sourceKind: 'run' | 'model') {
  const fixture = await artifactFixture(harness);
  fixture.app.route(
    '/api/mlflow/projects/:p',
    mlflowModelRoutes({ database: harness.database, registry: harness.services.registry }),
  );
  const model = sourceKind === 'model' ? await fixture.loggedModel() : null;
  const sourceRoot = model?.root ?? fixture.runRoot;
  const directory = sourceKind === 'run' ? 'saved/' : '';
  const mlmodel = 'flavors:\n  sklearn:\n    pickled_model: model.pkl\n';
  for (const [path, contents] of [
    ['MLmodel', mlmodel],
    ['model.pkl', 'fixed weights'],
    ['sub/config.json', '{}'],
  ]) {
    await entity(
      await request(
        fixture.app,
        transferUrl(fixture.mlflowPath, sourceRoot, `${directory}${path}`),
        {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: contents,
        },
      ),
      200,
    );
  }
  if (model)
    await entity(
      await request(fixture.app, `${fixture.mlflowPath}/api/2.0/mlflow/logged-models/${model.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { status: 'LOGGED_MODEL_READY' },
      }),
      200,
    );
  const registryPath = `${fixture.mlflowPath}/api/2.0/mlflow/registered-models`;
  const versionsPath = `${fixture.mlflowPath}/api/2.0/mlflow/model-versions`;
  const name = 'Immutable Registry';
  await entity(
    await request(fixture.app, `${registryPath}/create`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { name },
    }),
    200,
  );
  const source = `mlflow-artifacts:/${sourceRoot}${directory ? '/saved' : ''}`;
  const version = await entity<{ model_version: { version: string } }>(
    await request(fixture.app, `${versionsPath}/create`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { name, source, run_id: fixture.run.id },
    }),
    200,
  );
  await entity(
    await request(fixture.app, `${registryPath}/alias`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { name, version: version.model_version.version, alias: 'champion' },
    }),
    200,
  );
  const uri = await entity<{ artifact_uri: string }>(
    await request(
      fixture.app,
      `${versionsPath}/get-download-uri?name=${encodeURIComponent(name)}&version=${version.model_version.version}`,
      {
        cookie: fixture.viewer.cookie,
      },
    ),
    200,
  );
  const versionRoot = uri.artifact_uri.replace(/^mlflow-artifacts:\//, '');
  return {
    ...fixture,
    model,
    sourceRoot,
    directory,
    registryPath,
    versionsPath,
    name,
    version: version.model_version.version,
    versionRoot,
    versionId: versionRoot.split('/')[1]!,
    mlmodel,
  };
}
