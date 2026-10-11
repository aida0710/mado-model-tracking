import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Project, Run } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { modelFixture, type ModelFixture, type VersionResponse } from './mlflow-models-fixtures.js';

describe.skipIf(!testDatabaseUrl)('MLflow 3モデルバージョンの参照・検索・保存時の固定', () => {
  let harness: Harness;
  let fixture: ModelFixture;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await modelFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  function transferPath(uri: string, path = 'model.pkl') {
    return `${fixture.base}/api/2.0/mlflow-artifacts/artifacts${uri.slice('mlflow-artifacts:'.length)}/${path}`;
  }

  it('SDKのExperiment ID 0を同じProjectのnative Default Experimentへ解決する', async () => {
    const created = await entity<{ model: { info: { model_id: string; experiment_id: string } } }>(
      await request(fixture.app, fixture.modelEndpoint, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experiment_id: '0', name: 'standalone' },
      }),
      200,
    );
    const defaultExperiment = (
      await harness.database.query(
        "SELECT id FROM experiments WHERE project_id=$1 AND name='Default'",
        [fixture.project.id],
      )
    ).rows[0];
    expect(created.model.info.experiment_id).toBe(defaultExperiment.id);
    const matches = await entity<{ models: { info: { model_id: string } }[] }>(
      await request(fixture.app, `${fixture.modelEndpoint}/search`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { experiment_ids: ['0'] },
      }),
      200,
    );
    expect(matches.models.map((model) => model.info.model_id)).toEqual([
      created.model.info.model_id,
    ]);
  });

  it('元Logged Modelを削除しても登録バージョンとaliasは同じ重み・環境Artifactを読む', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel({ weights: 'immutable-weights' });
    const registered = await entity<VersionResponse>(
      await fixture.register(ready.model.info.model_id),
      200,
    );
    const download = await entity<{ artifact_uri: string }>(
      await request(
        fixture.app,
        `${fixture.versionEndpoint}/get-download-uri?name=Classifier&version=1`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(download.artifact_uri).toMatch(
      /^mlflow-artifacts:\/model-versions\/[a-f0-9-]{36}\/artifacts$/,
    );
    expect(registered.model_version.source).toBe(download.artifact_uri);
    await entity(
      await request(fixture.app, `${fixture.registryEndpoint}/alias`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Classifier', alias: 'champion', version: '1' },
      }),
      200,
    );
    await entity(
      await request(fixture.app, `${fixture.modelEndpoint}/${ready.model.info.model_id}`, {
        method: 'DELETE',
        cookie: fixture.editor.cookie,
        body: { model_id: ready.model.info.model_id },
      }),
      200,
    );
    expect(
      (
        await request(fixture.app, `${fixture.modelEndpoint}/${ready.model.info.model_id}`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
    const resolved = await entity<VersionResponse>(
      await request(
        fixture.app,
        `${fixture.registryEndpoint}/alias?name=Classifier&alias=champion`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    const weights = await request(fixture.app, transferPath(resolved.model_version.source), {
      cookie: fixture.viewer.cookie,
    });
    expect(weights.status).toBe(200);
    expect(await weights.text()).toBe('immutable-weights');
    expect(
      await (
        await request(fixture.app, transferPath(download.artifact_uri, 'requirements.txt'), {
          cookie: fixture.viewer.cookie,
        })
      ).text(),
    ).toBe('scikit-learn==1.9.1\n');
    expect(
      (
        await request(fixture.app, transferPath(download.artifact_uri), {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'replacement',
        })
      ).status,
    ).toBe(409);
  });

  it('Run Artifactを上書きしても既存登録バージョンは保存時の重みを読む', async () => {
    await entity(await fixture.createRegistered(), 200);
    const root = `${fixture.base}/api/2.0/mlflow-artifacts/artifacts/runs/${fixture.run.id}/artifacts/model`;
    for (const [path, binary] of Object.entries({
      MLmodel: 'flavors:\n  sklearn:\n    pickled_model: model.pkl\n',
      'model.pkl': 'old-weights',
      'requirements.txt': 'old-environment',
    })) {
      await entity(
        await request(fixture.app, `${root}/${path}`, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary,
        }),
        200,
      );
    }
    const registered = await entity<VersionResponse>(
      await request(fixture.app, `${fixture.versionEndpoint}/create`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'Classifier',
          source: `mlflow-artifacts:/runs/${fixture.run.id}/artifacts/model`,
          run_id: fixture.run.id,
        },
      }),
      200,
    );
    await entity(
      await request(fixture.app, `${root}/model.pkl`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: 'new-weights',
      }),
      200,
    );
    expect(
      await (
        await request(fixture.app, `${root}/model.pkl`, { cookie: fixture.viewer.cookie })
      ).text(),
    ).toBe('new-weights');
    const snapshot = await request(fixture.app, transferPath(registered.model_version.source), {
      cookie: fixture.viewer.cookie,
    });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.text()).toBe('old-weights');
  });

  it('native uploadで保存したモデル一式もindex未登録pathのfallbackからバージョン固定できる', async () => {
    await entity(await fixture.createRegistered(), 200);
    for (const [path, binary] of Object.entries({
      'model/MLmodel': 'flavors:\n  sklearn:\n    pickled_model: model.pkl\n',
      'model/model.pkl': 'native-weights',
    })) {
      await entity(
        await request(
          harness.app,
          `${fixture.basePath}/runs/${fixture.run.id}/artifacts?path=${encodeURIComponent(path)}`,
          { method: 'PUT', cookie: fixture.editor.cookie, binary },
        ),
      );
    }
    const registered = await entity<VersionResponse>(
      await request(fixture.app, `${fixture.versionEndpoint}/create`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Classifier', source: `runs:/${fixture.run.id}/model` },
      }),
      200,
    );
    const weights = await request(fixture.app, transferPath(registered.model_version.source), {
      cookie: fixture.viewer.cookie,
    });
    expect(weights.status).toBe(200);
    expect(await weights.text()).toBe('native-weights');
  });

  it('name/versionとname@aliasを登録sourceに使っても元のmanifestと由来を失わない', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel({ weights: 'promoted-weights' });
    await entity(await fixture.register(ready.model.info.model_id), 200);
    await entity(
      await request(fixture.app, `${fixture.registryEndpoint}/alias`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Classifier', alias: 'champion', version: '1' },
      }),
      200,
    );
    await entity(await fixture.createRegistered('Promoted'), 200);
    for (const source of ['models:/Classifier/1', 'models:/Classifier@champion']) {
      const registered = await entity<VersionResponse>(
        await request(fixture.app, `${fixture.versionEndpoint}/create`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name: 'Promoted', source },
        }),
        200,
      );
      expect(registered.model_version.run_id).toBe(fixture.run.id);
      expect(
        await (
          await request(fixture.app, transferPath(registered.model_version.source), {
            cookie: fixture.viewer.cookie,
          })
        ).text(),
      ).toBe('promoted-weights');
    }
    const versions = (
      await harness.database.query(
        "SELECT v.parent_model_version_ids FROM model_versions v JOIN models m ON m.id=v.model_id WHERE m.name='Promoted' ORDER BY v.version",
      )
    ).rows;
    expect(versions[0].parent_model_version_ids).toHaveLength(1);
    expect(versions[1].parent_model_version_ids).toEqual(versions[0].parent_model_version_ids);
  });

  it('別Projectのexperiment/run/logged modelは参照も登録もできない', async () => {
    const ready = await fixture.readyModel();
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other' },
      }),
    );
    const experiment = await entity<{ id: string }>(
      await request(harness.app, `/api/projects/${other.id}/experiments`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other experiment' },
      }),
    );
    const run = await entity<Run>(
      await request(harness.app, `/api/projects/${other.id}/runs`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other run', kind: 'training', experimentId: experiment.id },
      }),
    );
    for (const body of [
      { experiment_id: experiment.id },
      { experiment_id: fixture.experiment.id, source_run_id: run.id },
    ]) {
      expect(
        (
          await request(fixture.app, fixture.modelEndpoint, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body,
          })
        ).status,
      ).toBe(404);
    }
    const otherBase = `/api/mlflow/projects/${other.id}/api/2.0/mlflow`;
    expect(
      (
        await request(fixture.app, `${otherBase}/logged-models/${ready.model.info.model_id}`, {
          cookie: fixture.administrator.cookie,
        })
      ).status,
    ).toBe(404);
    await entity(
      await request(fixture.app, `${otherBase}/registered-models/create`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other classifier' },
      }),
      200,
    );
    expect(
      (
        await request(fixture.app, `${otherBase}/model-versions/create`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: {
            name: 'Other classifier',
            source: `models:/${ready.model.info.model_id}`,
            model_id: ready.model.info.model_id,
          },
        })
      ).status,
    ).toBe(404);
  });

  it('source_run_idと同じProjectでもExperimentが異なれば作成を拒否する', async () => {
    const experiment = await entity<{ id: string }>(
      await request(harness.app, `${fixture.basePath}/experiments`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Other same-project experiment' },
      }),
    );
    expect(
      (
        await request(fixture.app, fixture.modelEndpoint, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { experiment_id: experiment.id, source_run_id: fixture.run.id },
        })
      ).status,
    ).toBe(409);
  });

  it('MLmodelが参照する依存Artifactが未保存ならREADYへ確定しない', async () => {
    const created = await fixture.createLogged();
    const id = created.model.info.model_id;
    await entity(
      await fixture.upload(
        id,
        'MLmodel',
        'flavors:\n  python_function:\n    python_model: python_model.pkl\n    env:\n      virtualenv: python_env.yaml\n',
      ),
      200,
    );
    await entity(await fixture.upload(id, 'python_model.pkl', 'pickled-python-model'), 200);
    expect((await fixture.finalize(id)).status).toBe(409);
    await entity(await fixture.upload(id, 'python_env.yaml', 'python: 3.13\n'), 200);
    expect((await fixture.finalize(id)).status).toBe(200);
  });

  it('モデル本体がdirectoryのモデルをREADYにし、MLmodelをprimaryとして全ファイルを固定する', async () => {
    const created = await fixture.createLogged({ name: 'directory-model' });
    const id = created.model.info.model_id;
    for (const [path, binary] of Object.entries({
      MLmodel:
        'flavors:\n  python_function:\n    loader_module: mlflow.tensorflow\n    data: data\n  tensorflow:\n    saved_model_dir: data\n',
      'data/saved_model.pb': 'saved-model-descriptor',
      'data/variables/variables.index': 'variables-index',
      'data/variables/variables.data-00000-of-00001': 'variables-data',
      'requirements.txt': 'tensorflow==2.0\n',
    }))
      await entity(await fixture.upload(id, path, binary), 200);
    expect((await fixture.finalize(id)).status).toBe(200);
    await entity(await fixture.createRegistered(), 200);
    const registered = await entity<VersionResponse>(await fixture.register(id), 200);
    const stored = (await harness.database.query('SELECT artifact_id,metadata FROM model_versions'))
      .rows[0];
    expect(stored.metadata.mlflow.modelFormat).toBe('mlflow');
    expect(stored.metadata.mlflow.primaryArtifactPath).toBe('MLmodel');
    const descriptor = stored.metadata.mlflow.artifactManifest.find(
      (entry: { path: string }) => entry.path === 'MLmodel',
    );
    expect(stored.artifact_id).toBe(descriptor.artifactId);
    expect(stored.metadata.mlflow.artifactManifest).toHaveLength(5);
    expect(
      await (
        await request(
          fixture.app,
          transferPath(
            registered.model_version.source,
            'data/variables/variables.data-00000-of-00001',
          ),
          { cookie: fixture.viewer.cookie },
        )
      ).text(),
    ).toBe('variables-data');
  });

  it('複数の単一weightを含む保存済みモデルはREADYになるが、登録時の選択には明示tagを要求する', async () => {
    const created = await fixture.createLogged();
    const id = created.model.info.model_id;
    await entity(
      await fixture.upload(
        id,
        'MLmodel',
        'flavors:\n  sklearn:\n    pickled_model: model.pkl\n  python_function:\n    python_model: python_model.pkl\n',
      ),
      200,
    );
    await entity(await fixture.upload(id, 'model.pkl', 'sklearn-weights'), 200);
    await entity(await fixture.upload(id, 'python_model.pkl', 'pyfunc-weights'), 200);
    expect((await fixture.finalize(id)).status).toBe(200);
    await entity(await fixture.createRegistered(), 200);
    expect((await fixture.register(id)).status).toBe(422);
    expect(
      (await fixture.register(id, { tags: [{ key: 'mmt.weights_path', value: 'model.pkl' }] }))
        .status,
    ).toBe(200);
  });

  it('tag/params/metric・datasetで検索し、引用したANDと未知fieldを正しく扱う', async () => {
    const first = await fixture.createLogged({
      name: 'first',
      tags: [{ key: 'team', value: 'a AND b' }],
      params: [{ key: 'alpha', value: '1' }],
    });
    await fixture.createLogged({ name: 'second' });
    await entity(
      await request(fixture.app, `${fixture.base}/api/2.0/mlflow/runs/log-batch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          run_id: fixture.run.id,
          metrics: [
            {
              key: 'accuracy',
              value: 0.9,
              timestamp: '1791410400000',
              step: '1',
              model_id: first.model.info.model_id,
              dataset_name: 'validation',
              dataset_digest: 'v1',
            },
          ],
        },
      }),
      200,
    );
    const search = await entity<{ models: { info: { model_id: string } }[] }>(
      await request(fixture.app, `${fixture.modelEndpoint}/search`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: {
          experiment_ids: [fixture.experiment.id],
          filter: "tags.team = 'a AND b' AND params.alpha = '1' AND metrics.accuracy >= 0.8",
          datasets: [{ dataset_name: 'validation', dataset_digest: 'v1' }],
          order_by: [
            { field_name: 'metrics.accuracy', ascending: false, dataset_name: 'validation' },
          ],
        },
      }),
      200,
    );
    expect(search.models.map((model) => model.info.model_id)).toEqual([first.model.info.model_id]);
    const empty = await entity<{ models: unknown[] }>(
      await request(fixture.app, `${fixture.modelEndpoint}/search`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: {
          experiment_ids: [fixture.experiment.id],
          datasets: [{ dataset_name: 'validation', dataset_digest: 'v2' }],
        },
      }),
      200,
    );
    expect(empty.models).toHaveLength(0);
    for (const filter of [
      "unknown = 'ignored'",
      "tags.team = 'a' OR name = 'second'",
      "params.alpha > '1'",
    ])
      expect(
        (
          await request(fixture.app, `${fixture.modelEndpoint}/search`, {
            method: 'POST',
            cookie: fixture.viewer.cookie,
            body: { experiment_ids: [fixture.experiment.id], filter },
          })
        ).status,
      ).toBe(422);
  });

  it('Logged ModelとRegistryの検索pageを条件付きtokenでつなぐ', async () => {
    const ids = [];
    for (const name of ['A', 'B', 'C']) {
      ids.push((await fixture.createLogged({ name })).model.info.model_id);
      await entity(await fixture.createRegistered(name), 200);
    }
    const first = await entity<{
      models: { info: { model_id: string } }[];
      next_page_token: string;
    }>(
      await request(fixture.app, `${fixture.modelEndpoint}/search`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: {
          experiment_ids: [fixture.experiment.id],
          max_results: 2,
          order_by: [{ field_name: 'name' }],
        },
      }),
      200,
    );
    const second = await entity<{ models: { info: { model_id: string } }[] }>(
      await request(fixture.app, `${fixture.modelEndpoint}/search`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: {
          experiment_ids: [fixture.experiment.id],
          max_results: 2,
          order_by: [{ field_name: 'name' }],
          page_token: first.next_page_token,
        },
      }),
      200,
    );
    expect([...first.models, ...second.models].map((model) => model.info.model_id)).toEqual(ids);
    const registryFirst = await entity<{
      registered_models: { name: string }[];
      next_page_token: string;
    }>(
      await request(
        fixture.app,
        `${fixture.registryEndpoint}/search?max_results=2&order_by=name%20ASC`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    const registrySecond = await entity<{ registered_models: { name: string }[] }>(
      await request(
        fixture.app,
        `${fixture.registryEndpoint}/search?max_results=2&order_by=name%20ASC&page_token=${registryFirst.next_page_token}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(
      [...registryFirst.registered_models, ...registrySecond.registered_models].map(
        (model) => model.name,
      ),
    ).toEqual(['A', 'B', 'C']);
    expect(
      (
        await request(
          fixture.app,
          `${fixture.registryEndpoint}/search?filter=unknown%20%3D%20%27value%27`,
          { cookie: fixture.viewer.cookie },
        )
      ).status,
    ).toBe(422);
  });

  it('登録Modelを削除して再作成しても過去バージョンを再公開せず数字バージョンを再利用しない', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel();
    await entity(await fixture.register(ready.model.info.model_id), 200);
    await entity(
      await request(fixture.app, `${fixture.registryEndpoint}/delete`, {
        method: 'DELETE',
        cookie: fixture.editor.cookie,
        body: { name: 'Classifier' },
      }),
      200,
    );
    expect(
      (
        await request(fixture.app, `${fixture.registryEndpoint}/get?name=Classifier`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
    await entity(await fixture.createRegistered(), 200);
    expect(
      (
        await request(fixture.app, `${fixture.versionEndpoint}/get?name=Classifier&version=1`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (await entity<VersionResponse>(await fixture.register(ready.model.info.model_id), 200))
        .model_version.version,
    ).toBe('2');
  });
});
