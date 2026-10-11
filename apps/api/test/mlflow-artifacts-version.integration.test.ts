import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@mmt/contracts';
import { proxyListUrl, transferUrl } from './mlflow-artifacts-fixtures.js';
import { registeredVersionFixture } from './mlflow-artifacts-version-fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

describe.skipIf(!testDatabaseUrl)('登録モデルバージョンの固定Artifact参照（隔離PostgreSQL）', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness?.close();
  });

  it('RunのArtifact上書き後も登録済みversion/aliasは同じmanifestとbytesを読む', async () => {
    const fixture = await registeredVersionFixture(harness, 'run');
    await entity(
      await request(
        fixture.app,
        transferUrl(fixture.mlflowPath, fixture.sourceRoot, `${fixture.directory}model.pkl`),
        {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'updated weights',
        },
      ),
      200,
    );
    const alias = await entity<{ model_version: { version: string } }>(
      await request(
        fixture.app,
        `${fixture.registryPath}/alias?name=${encodeURIComponent(fixture.name)}&alias=champion`,
        {
          cookie: fixture.viewer.cookie,
        },
      ),
      200,
    );
    const uri = await entity<{ artifact_uri: string }>(
      await request(
        fixture.app,
        `${fixture.versionsPath}/get-download-uri?name=${encodeURIComponent(fixture.name)}&version=${alias.model_version.version}`,
        {
          cookie: fixture.viewer.cookie,
        },
      ),
      200,
    );
    expect(uri.artifact_uri).toBe(`mlflow-artifacts:/${fixture.versionRoot}`);
    expect(
      await (
        await request(
          fixture.app,
          transferUrl(fixture.mlflowPath, fixture.versionRoot, 'model.pkl'),
          {
            cookie: fixture.viewer.cookie,
          },
        )
      ).text(),
    ).toBe('fixed weights');
    expect(
      await entity(
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, fixture.versionRoot), {
          cookie: fixture.viewer.cookie,
        }),
        200,
      ),
    ).toEqual({
      files: [
        { path: 'MLmodel', is_dir: false, file_size: String(Buffer.byteLength(fixture.mlmodel)) },
        { path: 'model.pkl', is_dir: false, file_size: '13' },
        { path: 'sub', is_dir: true },
      ],
    });
    await harness.database.query("UPDATE runs SET lifecycle_stage='deleted' WHERE id=$1", [
      fixture.run.id,
    ]);
    expect(
      await (
        await request(
          fixture.app,
          transferUrl(fixture.mlflowPath, fixture.versionRoot, 'sub/config.json'),
          {
            cookie: fixture.viewer.cookie,
          },
        )
      ).text(),
    ).toBe('{}');
    expect(
      (
        await request(
          fixture.app,
          transferUrl(fixture.mlflowPath, fixture.versionRoot, 'model.pkl'),
          {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: 'mutated version',
          },
        )
      ).status,
    ).toBe(409);
  });

  it('Logged Model削除後も登録versionとaliasの固定URIからmodel一式を読む', async () => {
    const fixture = await registeredVersionFixture(harness, 'model');
    await entity(
      await request(
        fixture.app,
        `${fixture.mlflowPath}/api/2.0/mlflow/logged-models/${fixture.model!.id}`,
        {
          method: 'DELETE',
          cookie: fixture.editor.cookie,
        },
      ),
      200,
    );
    expect(
      (
        await request(
          fixture.app,
          transferUrl(fixture.mlflowPath, fixture.sourceRoot, 'model.pkl'),
          {
            cookie: fixture.viewer.cookie,
          },
        )
      ).status,
    ).toBe(404);
    const alias = await entity<{ model_version: { version: string } }>(
      await request(
        fixture.app,
        `${fixture.registryPath}/alias?name=${encodeURIComponent(fixture.name)}&alias=champion`,
        {
          cookie: fixture.viewer.cookie,
        },
      ),
      200,
    );
    expect(alias.model_version.version).toBe(fixture.version);
    for (const [path, bytes] of [
      ['MLmodel', fixture.mlmodel],
      ['model.pkl', 'fixed weights'],
      ['sub/config.json', '{}'],
    ]) {
      const download = await request(
        fixture.app,
        transferUrl(fixture.mlflowPath, fixture.versionRoot, path!),
        {
          cookie: fixture.viewer.cookie,
        },
      );
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(bytes);
    }
    expect((await harness.database.query('SELECT id FROM artifacts')).rows).toHaveLength(3);
  });

  it.each(['version', 'registered-model'] as const)(
    '%sがSDK側でsoftdeleteされたら固定URIを拒否する',
    async (kind) => {
      const fixture = await registeredVersionFixture(harness, 'run');
      await entity(
        await request(
          fixture.app,
          `${kind === 'version' ? fixture.versionsPath : fixture.registryPath}/delete`,
          {
            method: 'DELETE',
            cookie: fixture.editor.cookie,
            body:
              kind === 'version'
                ? { name: fixture.name, version: fixture.version }
                : { name: fixture.name },
          },
        ),
        200,
      );
      expect(
        (
          await request(fixture.app, proxyListUrl(fixture.mlflowPath, fixture.versionRoot), {
            cookie: fixture.viewer.cookie,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            fixture.app,
            transferUrl(fixture.mlflowPath, fixture.versionRoot, 'model.pkl'),
            {
              cookie: fixture.viewer.cookie,
            },
          )
        ).status,
      ).toBe(404);
      expect((await harness.database.query('SELECT id FROM artifacts')).rows).toHaveLength(3);
    },
  );

  it('固定URIにもread scope/current membership/project境界を適用する', async () => {
    const fixture = await registeredVersionFixture(harness, 'run');
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Artifact Project' },
      }),
    );
    const url = transferUrl(fixture.mlflowPath, fixture.versionRoot, 'model.pkl');
    expect((await request(fixture.app, url, { cookie: fixture.outsider.cookie })).status).toBe(403);
    expect(
      (
        await request(
          fixture.app,
          transferUrl(`/api/mlflow/projects/${other.id}`, fixture.versionRoot, 'model.pkl'),
          {
            cookie: fixture.administrator.cookie,
          },
        )
      ).status,
    ).toBe(404);
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: {
          name: 'Version readonly',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    expect((await request(fixture.app, url, { token: minted.token })).status).toBe(200);
    await harness.database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [
      fixture.project.id,
      fixture.viewer.userId,
    ]);
    expect((await request(fixture.app, url, { token: minted.token })).status).toBe(401);
    expect((await request(fixture.app, url, { cookie: fixture.viewer.cookie })).status).toBe(403);
  });
});
