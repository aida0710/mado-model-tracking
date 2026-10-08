import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Code, CodeVersion, Project } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import {
  modelFixture,
  type LoggedModelResponse,
  type ModelFixture,
  type VersionResponse,
} from './mlflow-models-fixtures.js';

describe.skipIf(!testDatabaseUrl)('MLflow 3 Logged Models / native Model Registry', () => {
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

  it('初期化したモデルを公式protoのinfo/data階層とPENDING enumで取得できる', async () => {
    const created = await fixture.createLogged({
      params: [{ key: 'alpha', value: '1' }],
      tags: [{ key: 'source', value: 'sklearn' }],
    });
    expect(created.model.info.model_id).toMatch(/^m-[a-f0-9]{32}$/);
    expect(created.model.info.status).toBe('LOGGED_MODEL_PENDING');
    expect(created.model.info.artifact_uri).toBe(
      `mlflow-artifacts:/models/${created.model.info.model_id}/artifacts`,
    );
    const loaded = await entity<LoggedModelResponse>(
      await request(fixture.app, `${fixture.modelEndpoint}/${created.model.info.model_id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(loaded.model.data.params).toEqual([{ key: 'alpha', value: '1' }]);
    expect(loaded.model.info.source_run_id).toBe(fixture.run.id);
  });

  it('MLmodelと重みが保存されるまでREADYにできず、FAILEDからREADYへ戻せない', async () => {
    const pending = await fixture.createLogged();
    const id = pending.model.info.model_id;
    expect((await fixture.finalize(id)).status).toBe(409);
    await entity(
      await fixture.upload(id, 'MLmodel', 'flavors:\n  sklearn:\n    pickled_model: model.pkl\n'),
      200,
    );
    expect((await fixture.finalize(id)).status).toBe(409);
    await entity(await fixture.finalize(id, 'LOGGED_MODEL_UPLOAD_FAILED'), 200);
    expect((await fixture.finalize(id)).status).toBe(409);
    expect((await fixture.upload(id, 'model.pkl', 'late-weights')).status).toBe(409);
  });

  it('READY確定は再送でき、重みやMLmodelの上書きは拒否する', async () => {
    const ready = await fixture.readyModel();
    const id = ready.model.info.model_id;
    expect((await fixture.finalize(id)).status).toBe(200);
    expect((await fixture.upload(id, 'model.pkl', 'replacement')).status).toBe(409);
    expect((await fixture.upload(id, 'MLmodel', '{}')).status).toBe(409);
    expect((await fixture.finalize(id, 'LOGGED_MODEL_UPLOAD_FAILED')).status).toBe(409);
  });

  it('paramsの同値再送と追加は成功し、異なる値のbatchは全体をrollbackする', async () => {
    const created = await fixture.createLogged({ params: [{ key: 'alpha', value: '1' }] });
    const path = `${fixture.modelEndpoint}/${created.model.info.model_id}/params`;
    expect(
      (
        await request(fixture.app, path, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            params: [
              { key: 'alpha', value: '1' },
              { key: 'beta', value: '2' },
            ],
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(fixture.app, path, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            params: [
              { key: 'alpha', value: '9' },
              { key: 'new', value: '3' },
            ],
          },
        })
      ).status,
    ).toBe(409);
    const stored = await entity<LoggedModelResponse>(
      await request(fixture.app, `${fixture.modelEndpoint}/${created.model.info.model_id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(
      Object.fromEntries(stored.model.data.params.map((param) => [param.key, param.value])),
    ).toEqual({ alpha: '1', beta: '2' });
  });

  it('tagsを更新・削除でき、重複keyへ異なる値を渡したbatchは拒否する', async () => {
    const created = await fixture.createLogged();
    const path = `${fixture.modelEndpoint}/${created.model.info.model_id}/tags`;
    expect(
      (
        await request(fixture.app, path, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { tags: [{ key: 'owner', value: 'first' }] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(fixture.app, path, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: {
            tags: [
              { key: 'owner', value: 'second' },
              { key: 'owner', value: 'third' },
            ],
          },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(fixture.app, `${path}/owner`, {
          method: 'DELETE',
          cookie: fixture.editor.cookie,
        })
      ).status,
    ).toBe(200);
  });

  it('モデルmetricはdatasetを保持し、同じpointの再送が重複しない', async () => {
    const created = await fixture.createLogged();
    const body = {
      run_id: fixture.run.id,
      metrics: [
        {
          key: 'accuracy',
          value: 0.91,
          timestamp: '1791410400000',
          step: '2',
          model_id: created.model.info.model_id,
          dataset_name: 'validation',
          dataset_digest: 'digest-v1',
        },
      ],
    };
    const endpoint = `${fixture.base}/api/2.0/mlflow/runs/log-batch`;
    for (const retry of [1, 2]) {
      expect(
        (
          await request(fixture.app, endpoint, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body,
          })
        ).status,
        `retry ${retry}`,
      ).toBe(200);
    }
    const loaded = await entity<LoggedModelResponse>(
      await request(fixture.app, `${fixture.modelEndpoint}/${created.model.info.model_id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(loaded.model.data.metrics).toMatchObject([
      {
        key: 'accuracy',
        value: 0.91,
        run_id: fixture.run.id,
        dataset_name: 'validation',
        dataset_digest: 'digest-v1',
      },
    ]);
    const count = await harness.database.query(
      'SELECT count(*)::int AS count FROM mlflow_logged_model_metrics WHERE model_id=$1',
      [created.model.info.model_id],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it('Logged Modelを削除すると通常の取得・検索・登録から隠れ、許可されたdeleted取得だけが成功する', async () => {
    const ready = await fixture.readyModel();
    const path = `${fixture.modelEndpoint}/${ready.model.info.model_id}`;
    expect(
      (
        await request(fixture.app, path, {
          method: 'DELETE',
          cookie: fixture.editor.cookie,
          body: { model_id: ready.model.info.model_id },
        })
      ).status,
    ).toBe(200);
    expect((await request(fixture.app, path, { cookie: fixture.viewer.cookie })).status).toBe(404);
    expect(
      (await request(fixture.app, `${path}?allow_deleted=true`, { cookie: fixture.viewer.cookie }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(fixture.app, `${path}?allow_deleted=true`, {
          cookie: fixture.outsider.cookie,
        })
      ).status,
    ).toBe(403);
    const search = await entity<{ models: unknown[] }>(
      await request(fixture.app, `${fixture.modelEndpoint}/search`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { experiment_ids: [fixture.experiment.id] },
      }),
      200,
    );
    expect(search.models).toHaveLength(0);
    await entity(await fixture.createRegistered(), 200);
    expect((await fixture.register(ready.model.info.model_id)).status).toBe(404);
  });

  it('viewer・未参加者・read-only token・別Project tokenはモデル更新できない', async () => {
    const created = await fixture.createLogged();
    const path = `${fixture.modelEndpoint}/${created.model.info.model_id}/params`;
    for (const cookie of [fixture.viewer.cookie, fixture.outsider.cookie])
      expect(
        (await request(fixture.app, path, { method: 'POST', cookie, body: { params: [] } })).status,
      ).toBe(403);
    const readOnly = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'read-only',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    expect(
      (
        await request(fixture.app, path, {
          method: 'POST',
          token: readOnly.token,
          body: { params: [] },
        })
      ).status,
    ).toBe(403);
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other' },
      }),
    );
    const restricted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'other-token',
          kind: 'service',
          projectId: other.id,
          scopes: ['registry:write'],
        },
      }),
    );
    expect(
      (
        await request(fixture.app, path, {
          method: 'POST',
          token: restricted.token,
          body: { params: [] },
        })
      ).status,
    ).toBe(403);
  });

  it('現在のmembership・scope・失効を毎リクエスト確認する', async () => {
    const minted = await entity<{ token: string; item: { id: string } }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'models-write',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['registry:write', 'read'],
        },
      }),
    );
    const created = await fixture.createLogged();
    const path = `${fixture.modelEndpoint}/${created.model.info.model_id}/params`;
    expect(
      (
        await request(fixture.app, path, {
          method: 'POST',
          token: minted.token,
          body: { params: [] },
        })
      ).status,
    ).toBe(200);
    await harness.database.query("UPDATE api_tokens SET scopes=ARRAY['read'] WHERE id=$1", [
      minted.item.id,
    ]);
    expect(
      (
        await request(fixture.app, path, {
          method: 'POST',
          token: minted.token,
          body: { params: [] },
        })
      ).status,
    ).toBe(403);
    await harness.database.query(
      "UPDATE api_tokens SET scopes=ARRAY['registry:write','read'] WHERE id=$1",
      [minted.item.id],
    );
    await harness.database.query('DELETE FROM project_members WHERE user_id=$1 AND project_id=$2', [
      fixture.editor.userId,
      fixture.project.id,
    ]);
    expect(
      (
        await request(fixture.app, path, {
          method: 'POST',
          token: minted.token,
          body: { params: [] },
        })
      ).status,
    ).toBe(401);
    await harness.database.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [
      minted.item.id,
    ]);
    expect(
      (
        await request(fixture.app, `${fixture.modelEndpoint}/${created.model.info.model_id}`, {
          token: minted.token,
        })
      ).status,
    ).toBe(401);
  });

  it('registered Modelの重複作成はSDKが再利用を判断できるcodeを返す', async () => {
    await entity(await fixture.createRegistered(), 200);
    const duplicate = await fixture.createRegistered();
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe('resource_already_exists');
  });

  it('PENDING/FAILEDモデルや任意URIはnative版とautomationを作らない', async () => {
    await entity(await fixture.createRegistered(), 200);
    const pending = await fixture.createLogged();
    expect((await fixture.register(pending.model.info.model_id)).status).toBe(409);
    await entity(
      await fixture.finalize(pending.model.info.model_id, 'LOGGED_MODEL_UPLOAD_FAILED'),
      200,
    );
    expect((await fixture.register(pending.model.info.model_id)).status).toBe(409);
    expect(
      (
        await request(fixture.app, `${fixture.versionEndpoint}/create`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name: 'Classifier', source: 'https://example.invalid/model.pkl' },
        })
      ).status,
    ).toBe(422);
    for (const source of [
      'runs:/------------------------------------/model',
      'mlflow-artifacts:/runs/------------------------------------/artifacts/model',
    ])
      expect(
        (
          await request(fixture.app, `${fixture.versionEndpoint}/create`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { name: 'Classifier', source },
          })
        ).status,
      ).toBe(422);
    const versions = await harness.database.query(
      'SELECT count(*)::int AS count FROM model_versions',
    );
    const events = await harness.database.query(
      'SELECT count(*)::int AS count FROM model_automation_events',
    );
    expect(versions.rows[0].count).toBe(0);
    expect(events.rows[0].count).toBe(0);
  });

  it('registered版はnative weights Artifact・全ファイルmanifest・source Runとautomation eventを保存する', async () => {
    const ready = await fixture.readyModel();
    await entity(await fixture.createRegistered(), 200);
    const registered = await entity<VersionResponse>(
      await fixture.register(ready.model.info.model_id),
      200,
    );
    expect(registered.model_version.version).toBe('1');
    expect(registered.model_version.run_id).toBe(fixture.run.id);
    const stored = (
      await harness.database.query('SELECT * FROM model_versions WHERE version=$1', ['1'])
    ).rows[0];
    expect(stored.source_run_id).toBe(fixture.run.id);
    expect(
      stored.metadata.mlflow.artifactManifest.map((entry: { path: string }) => entry.path),
    ).toEqual(['MLmodel', 'model.pkl', 'python_env.yaml', 'requirements.txt']);
    const weights = stored.metadata.mlflow.artifactManifest.find(
      (entry: { path: string }) => entry.path === 'model.pkl',
    );
    expect(stored.artifact_id).toBe(weights.artifactId);
    expect(stored.weights_uri).toBe(
      `/api/projects/${fixture.project.id}/artifacts/${weights.artifactId}/content`,
    );
    expect(
      (await harness.database.query('SELECT model_version_id FROM model_automation_events')).rows,
    ).toEqual([{ model_version_id: stored.id }]);
    const lineage = await entity<{ edges: { source: string; target: string; relation: string }[] }>(
      await request(harness.app, `${fixture.basePath}/lineage`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(lineage.edges).toContainEqual({
      source: fixture.run.id,
      target: stored.id,
      relation: 'outputModel',
    });
  });

  it('異なる重みの複数版を作り、native aliasとMLflow aliasが同じ版を指す', async () => {
    await entity(await fixture.createRegistered(), 200);
    const first = await fixture.readyModel({ weights: 'first-weights' });
    const second = await fixture.readyModel({ weights: 'second-weights' });
    await entity<VersionResponse>(await fixture.register(first.model.info.model_id), 200);
    await entity<VersionResponse>(await fixture.register(second.model.info.model_id), 200);
    for (const version of ['1', '2']) {
      expect(
        (
          await request(fixture.app, `${fixture.registryEndpoint}/alias`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { name: 'Classifier', alias: 'champion', version },
          })
        ).status,
      ).toBe(200);
      const resolved = await entity<VersionResponse>(
        await request(
          fixture.app,
          `${fixture.registryEndpoint}/alias?name=Classifier&alias=champion`,
          { cookie: fixture.viewer.cookie },
        ),
        200,
      );
      expect(resolved.model_version.version).toBe(version);
      const stored = (
        await harness.database.query(
          'SELECT v.version FROM model_aliases a JOIN model_versions v ON v.id=a.version_id WHERE a.alias=$1',
          ['champion'],
        )
      ).rows;
      expect(stored).toEqual([{ version }]);
    }
    expect(
      (
        await request(fixture.app, `${fixture.registryEndpoint}/alias`, {
          method: 'POST',
          cookie: fixture.viewer.cookie,
          body: { name: 'Classifier', alias: 'champion', version: '1' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(fixture.app, `${fixture.registryEndpoint}/alias`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name: 'Classifier', alias: 'v1', version: '1' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(fixture.app, `${fixture.registryEndpoint}/alias`, {
          method: 'DELETE',
          cookie: fixture.editor.cookie,
          body: { name: 'Classifier', alias: 'champion' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          fixture.app,
          `${fixture.registryEndpoint}/alias?name=Classifier&alias=champion`,
          { cookie: fixture.viewer.cookie },
        )
      ).status,
    ).toBe(404);
  });

  it('同じModelへの並行登録で数字版を原子採番しautomationを各版で一度処理する', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => fixture.register(ready.model.info.model_id)),
    );
    const versions = await Promise.all(
      responses.map((response) => entity<VersionResponse>(response, 200)),
    );
    expect(versions.map((response) => response.model_version.version).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(
      (await harness.database.query('SELECT count(*)::int AS count FROM model_automation_events'))
        .rows[0].count,
    ).toBe(6);
  });

  it('JavaScriptの安全整数を超える数字版を文字列のまま採番・検索する', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel();
    await harness.database.query('UPDATE mlflow_registered_model_metadata SET next_version=$1', [
      '9007199254740993',
    ]);
    const first = await entity<VersionResponse>(
      await fixture.register(ready.model.info.model_id),
      200,
    );
    const second = await entity<VersionResponse>(
      await fixture.register(ready.model.info.model_id),
      200,
    );
    expect(first.model_version.version).toBe('9007199254740993');
    expect(second.model_version.version).toBe('9007199254740994');
    const filter = new URLSearchParams({ filter: 'version = 9007199254740993' });
    const found = await entity<{ model_versions: VersionResponse['model_version'][] }>(
      await request(fixture.app, `${fixture.versionEndpoint}/search?${filter}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(found.model_versions.map((version) => version.version)).toEqual(['9007199254740993']);
  });

  it('補助metadataの保存失敗はnative版・採番・automation eventを同時にrollbackする', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel();
    await harness.database.query(
      "CREATE FUNCTION reject_mlflow_model_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure' USING ERRCODE='23514'; END $$",
    );
    await harness.database.query(
      'CREATE TRIGGER fail_mlflow_model_metadata BEFORE INSERT ON mlflow_model_version_metadata FOR EACH ROW EXECUTE FUNCTION reject_mlflow_model_metadata()',
    );
    try {
      expect((await fixture.register(ready.model.info.model_id)).status).toBe(422);
    } finally {
      await harness.database.query(
        'DROP TRIGGER fail_mlflow_model_metadata ON mlflow_model_version_metadata',
      );
      await harness.database.query('DROP FUNCTION reject_mlflow_model_metadata()');
    }
    expect(
      (await harness.database.query('SELECT count(*)::int AS count FROM model_versions')).rows[0]
        .count,
    ).toBe(0);
    expect(
      (await harness.database.query('SELECT count(*)::int AS count FROM model_automation_events'))
        .rows[0].count,
    ).toBe(0);
    const retried = await entity<VersionResponse>(
      await fixture.register(ready.model.info.model_id),
      200,
    );
    expect(retried.model_version.version).toBe('1');
  });

  it('Run outputsの再送と同じsourceモデルの並行登録はdeadlockせず完了する', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel();
    const outputRequests = Array.from({ length: 6 }, () =>
      request(fixture.app, `${fixture.base}/api/2.0/mlflow/runs/outputs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          run_id: fixture.run.id,
          models: [{ model_id: ready.model.info.model_id, step: '0' }],
        },
      }),
    );
    const registrationRequests = Array.from({ length: 6 }, () =>
      fixture.register(ready.model.info.model_id),
    );
    const responses = await Promise.all([...outputRequests, ...registrationRequests]);
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(200));
    expect(
      (await harness.database.query('SELECT count(*)::int AS count FROM model_automation_events'))
        .rows[0].count,
    ).toBe(6);
  });

  it('mmt family/defaultCodeタグをnative互換性検証へ渡し、別Projectコードと不一致系列を拒否する', async () => {
    const code = await entity<Code>(
      await request(harness.app, `${fixture.basePath}/codes`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Native inference' },
      }),
    );
    const version = await entity<CodeVersion>(
      await request(harness.app, `${fixture.basePath}/codes/${code.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v1',
          source: { kind: 'inline', files: { 'main.py': 'print(1)' } },
          entrypoint: ['python', 'main.py'],
          supportedModelFamilies: ['sklearn'],
          taskTypes: ['inference'],
        },
      }),
    );
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel({
      tags: [
        { key: 'mmt.model_family', value: 'sklearn' },
        { key: 'mmt.code_version_id', value: version.id },
      ],
    });
    const registered = await entity<VersionResponse>(
      await fixture.register(ready.model.info.model_id),
      200,
    );
    const stored = (
      await harness.database.query(
        'SELECT m.family,v.default_code_version_id FROM models m JOIN model_versions v ON v.model_id=m.id',
      )
    ).rows[0];
    expect(stored).toEqual({ family: 'sklearn', default_code_version_id: version.id });
    const incompatible = await fixture.readyModel({
      tags: [
        { key: 'mmt.model_family', value: 'other' },
        { key: 'mmt.code_version_id', value: version.id },
      ],
    });
    expect((await fixture.register(incompatible.model.info.model_id)).status).toBe(409);
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other' },
      }),
    );
    const otherCode = await entity<Code>(
      await request(harness.app, `/api/projects/${other.id}/codes`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Code' },
      }),
    );
    const otherVersion = await entity<CodeVersion>(
      await request(harness.app, `/api/projects/${other.id}/codes/${otherCode.id}/versions`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          version: 'v1',
          source: { kind: 'inline', files: { 'main.py': 'print(1)' } },
          entrypoint: ['python', 'main.py'],
          supportedModelFamilies: ['sklearn'],
          taskTypes: ['inference'],
        },
      }),
    );
    expect(
      (
        await fixture.register(ready.model.info.model_id, {
          tags: [{ key: 'mmt.code_version_id', value: otherVersion.id }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fixture.register(ready.model.info.model_id, {
          runId: '00000000-0000-4000-8000-000000000001',
        })
      ).status,
    ).toBe(409);
    expect(registered.model_version.version).toBe('1');
  });

  it('description/tag/stageだけを変更し、native weightsと版のmetadataは不変のまま保持する', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel();
    await entity(await fixture.register(ready.model.info.model_id), 200);
    const before = (await harness.database.query('SELECT * FROM model_versions')).rows[0];
    await entity(
      await request(fixture.app, `${fixture.versionEndpoint}/update`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { name: 'Classifier', version: '1', description: 'Updated' },
      }),
      200,
    );
    expect(
      (
        await request(fixture.app, `${fixture.versionEndpoint}/set-tag`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name: 'Classifier', version: '1', key: 'reviewed', value: 'true' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(fixture.app, `${fixture.versionEndpoint}/set-tag`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            name: 'Classifier',
            version: '1',
            key: 'mmt.weights_path',
            value: 'different.pkl',
          },
        })
      ).status,
    ).toBe(409);
    await entity(
      await request(fixture.app, `${fixture.versionEndpoint}/transition-stage`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'Classifier',
          version: '1',
          stage: 'Production',
          archive_existing_versions: true,
        },
      }),
      200,
    );
    expect((await harness.database.query('SELECT * FROM model_versions')).rows[0]).toEqual(before);
    const loaded = await entity<VersionResponse>(
      await request(fixture.app, `${fixture.versionEndpoint}/get?name=Classifier&version=1`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(loaded.model_version).toMatchObject({
      description: 'Updated',
      current_stage: 'Production',
    });
  });

  it('削除した版のaliasを消し、参照を保持したnative版は残し採番を再利用しない', async () => {
    await entity(await fixture.createRegistered(), 200);
    const ready = await fixture.readyModel();
    await entity(await fixture.register(ready.model.info.model_id), 200);
    await entity(
      await request(fixture.app, `${fixture.registryEndpoint}/alias`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Classifier', alias: 'champion', version: '1' },
      }),
      200,
    );
    expect(
      (
        await request(fixture.app, `${fixture.versionEndpoint}/delete`, {
          method: 'DELETE',
          cookie: fixture.editor.cookie,
          body: { name: 'Classifier', version: '1' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(fixture.app, `${fixture.versionEndpoint}/get?name=Classifier&version=1`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (await harness.database.query('SELECT count(*)::int AS count FROM model_versions')).rows[0]
        .count,
    ).toBe(1);
    expect(
      (await harness.database.query('SELECT count(*)::int AS count FROM model_aliases')).rows[0]
        .count,
    ).toBe(0);
    expect(
      (await entity<VersionResponse>(await fixture.register(ready.model.info.model_id), 200))
        .model_version.version,
    ).toBe('2');
  });
});
