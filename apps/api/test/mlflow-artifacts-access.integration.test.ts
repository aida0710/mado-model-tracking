import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@mmt/contracts';
import { artifactFixture, proxyListUrl, transferUrl } from './mlflow-artifacts-fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

describe.skipIf(!testDatabaseUrl)('MLflow Artifactの権限とowner検証（隔離PostgreSQL）', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness?.close();
  });

  it('未認証・非メンバー・viewerのuploadを保存前に拒否する', async () => {
    const fixture = await artifactFixture(harness);
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'protected.bin');
    for (const [cookie, status] of [
      [undefined, 401],
      [fixture.outsider.cookie, 403],
      [fixture.viewer.cookie, 403],
    ] as const) {
      expect(
        (await request(fixture.app, url, { method: 'PUT', cookie, binary: 'private' })).status,
      ).toBe(status);
    }
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(0);
    expect((await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows).toHaveLength(
      0,
    );
    expect(
      (
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, fixture.runRoot), {
          cookie: fixture.outsider.cookie,
        })
      ).status,
    ).toBe(403);
  });

  it('読取専用tokenはlist/downloadでき、uploadには使えない', async () => {
    const fixture = await artifactFixture(harness);
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'readable.bin');
    await request(fixture.app, url, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      binary: 'read only',
    });
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: {
          name: 'Artifact read test',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    expect(
      (
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, fixture.runRoot), {
          token: minted.token,
        })
      ).status,
    ).toBe(200);
    expect(await (await request(fixture.app, url, { token: minted.token })).text()).toBe(
      'read only',
    );
    expect(
      (await request(fixture.app, url, { method: 'PUT', token: minted.token, binary: 'forbidden' }))
        .status,
    ).toBe(403);
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(1);
  });

  it('Artifact書込み専用tokenでMLmodelを保存でき、読取scopeは追加要求しない', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel();
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'Artifact write test',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['artifacts:write'],
        },
      }),
    );
    const url = transferUrl(fixture.mlflowPath, model.root, 'MLmodel');
    expect(
      (
        await request(fixture.app, url, {
          method: 'PUT',
          token: minted.token,
          binary: 'flavors:\n  sklearn:\n    pickled_model: model.pkl\n',
        })
      ).status,
    ).toBe(200);
    expect((await request(fixture.app, url, { token: minted.token })).status).toBe(403);
    expect(
      (
        await harness.database.query<{ metadata: { mlmodel: unknown } }>(
          'SELECT metadata FROM mlflow_logged_models WHERE id=$1',
          [model.id],
        )
      ).rows[0]!.metadata.mlmodel,
    ).toEqual({ flavors: { sklearn: { pickled_model: 'model.pkl' } } });
  });

  it('同じprojectの権限があっても、別projectのrun/model ownerを解決しない', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel();
    const otherProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherPath = `/api/mlflow/projects/${otherProject.id}`;
    for (const root of [fixture.runRoot, model.root]) {
      expect(
        (
          await request(fixture.app, transferUrl(otherPath, root, 'cross-project.bin'), {
            method: 'PUT',
            cookie: fixture.administrator.cookie,
            binary: 'forbidden',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(fixture.app, proxyListUrl(otherPath, root), {
            cookie: fixture.administrator.cookie,
          })
        ).status,
      ).toBe(404);
    }
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Project bounded',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read', 'artifacts:write'],
        },
      }),
    );
    expect(
      (
        await request(fixture.app, transferUrl(otherPath, fixture.runRoot, 'token.bin'), {
          method: 'PUT',
          token: minted.token,
          binary: 'forbidden',
        })
      ).status,
    ).toBe(403);
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(0);
  });

  it('未作成ownerとsoftdeleteしたrun/model/experimentを読書きとも拒否する', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel();
    const roots = [
      `runs/${randomUUID()}/artifacts`,
      `models/m-${randomUUID().replaceAll('-', '')}/artifacts`,
    ];
    await harness.database.query("UPDATE runs SET lifecycle_stage='deleted' WHERE id=$1", [
      fixture.run.id,
    ]);
    await harness.database.query('UPDATE mlflow_logged_models SET deleted_at=now() WHERE id=$1', [
      model.id,
    ]);
    roots.push(fixture.runRoot, model.root);
    for (const root of roots) {
      expect(
        (
          await request(fixture.app, transferUrl(fixture.mlflowPath, root, 'missing.bin'), {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: 'forbidden',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(fixture.app, proxyListUrl(fixture.mlflowPath, root), {
            cookie: fixture.viewer.cookie,
          })
        ).status,
      ).toBe(404);
    }
    await harness.database.query("UPDATE runs SET lifecycle_stage='active' WHERE id=$1", [
      fixture.run.id,
    ]);
    await harness.database.query("UPDATE experiments SET lifecycle_stage='deleted' WHERE id=$1", [
      fixture.experiment.id,
    ]);
    expect(
      (
        await request(
          fixture.app,
          transferUrl(fixture.mlflowPath, fixture.runRoot, 'deleted-experiment.bin'),
          {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: 'forbidden',
          },
        )
      ).status,
    ).toBe(404);
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(0);
  });

  it.each(['READY', 'FAILED'])(
    '%s modelでは上書きと追加uploadを拒否し、読取りは保持する',
    async (status) => {
      const fixture = await artifactFixture(harness);
      const model = await fixture.loggedModel();
      const url = transferUrl(fixture.mlflowPath, model.root, 'model.pkl');
      await request(fixture.app, url, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: 'frozen',
      });
      await harness.database.query('UPDATE mlflow_logged_models SET status=$2 WHERE id=$1', [
        model.id,
        status,
      ]);
      for (const path of ['model.pkl', 'new-file.bin']) {
        expect(
          (
            await request(fixture.app, transferUrl(fixture.mlflowPath, model.root, path), {
              method: 'PUT',
              cookie: fixture.editor.cookie,
              binary: 'mutated',
            })
          ).status,
        ).toBe(409);
      }
      expect(
        await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text(),
      ).toBe('frozen');
      expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(1);
    },
  );

  it('traversal・backslash・absolute・double encodingをPUT/GET/listすべてで拒否する', async () => {
    const fixture = await artifactFixture(harness);
    const unsafePaths = [
      '../secret',
      'a/../secret',
      'a\\secret',
      '/etc/passwd',
      'C:/secret',
      '%2e%2e/secret',
      '%252e%252e/secret',
      'a//b',
      'a/./b',
      'a\0b',
    ];
    for (const path of unsafePaths) {
      // Encoding the full path preserves dot segments until the server validates them.
      const url = `${fixture.mlflowPath}/api/2.0/mlflow-artifacts/artifacts/${fixture.runRoot}/${encodeURIComponent(path)}`;
      const upload = await request(fixture.app, url, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: 'unsafe',
      });
      expect([404, 422]).toContain(upload.status);
      expect([404, 422]).toContain(
        (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).status,
      );
      expect(
        (
          await request(
            fixture.app,
            proxyListUrl(fixture.mlflowPath, `${fixture.runRoot}/${path}`),
            {
              cookie: fixture.viewer.cookie,
            },
          )
        ).status,
      ).toBe(422);
      expect(
        (
          await request(
            fixture.app,
            `${fixture.mlflowPath}/api/2.0/mlflow/artifacts/list?run_id=${fixture.run.id}&path=${encodeURIComponent(path)}`,
            {
              cookie: fixture.viewer.cookie,
            },
          )
        ).status,
      ).toBe(422);
    }
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(0);
  });
});
