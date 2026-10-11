import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Model, ModelAliasEvent, ModelAliasEventPage, ModelVersion } from '@mmt/contracts';
import { transaction } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { assignModelAlias } from '../src/repositories/modelAliasRepository.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { applyMigrationsBefore } from './migrationFixtures.js';
import { projectFixture } from './fixtures.js';

type ProjectFixture = Awaited<ReturnType<typeof projectFixture>>;

async function registryFixture(harness: Harness) {
  const fixture = await projectFixture(harness);
  const model = await entity<Model>(
    await request(harness.app, `${fixture.basePath}/models`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { name: 'Classifier', family: 'qwen2' },
    }),
  );
  const versions: ModelVersion[] = [];
  for (let index = 0; index < 3; index += 1)
    versions.push(
      await entity<ModelVersion>(
        await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { weightsUri: `file:///weights/${index + 1}` },
        }),
      ),
    );
  const modelPath = `${fixture.basePath}/models/${model.id}`;
  const mlflowBase = `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow`;
  return { ...fixture, model, versions, modelPath, mlflowBase };
}

function putAlias(
  harness: Harness,
  fixture: { modelPath: string },
  change: {
    alias: string;
    versionId: string;
    reason?: string;
    cookie?: string;
    token?: string;
  },
) {
  return request(harness.app, `${fixture.modelPath}/aliases/${change.alias}`, {
    method: 'PUT',
    cookie: change.cookie,
    token: change.token,
    body: {
      versionId: change.versionId,
      ...(change.reason ? { reason: change.reason } : {}),
    },
  });
}

async function aliasEvents(
  harness: Harness,
  fixture: { modelPath: string; viewer: ProjectFixture['viewer'] },
  query = '',
): Promise<ModelAliasEventPage> {
  return entity<ModelAliasEventPage>(
    await request(harness.app, `${fixture.modelPath}/alias-events${query}`, {
      cookie: fixture.viewer.cookie,
    }),
    200,
  );
}

describe.skipIf(!testDatabaseUrl)('alias変更の履歴（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('native PUTで版を切り替えると旧版→新版・操作者・理由のeventが1件増え、同じ版の再設定では増えない', async () => {
    const fixture = await registryFixture(harness);
    const [first, second] = fixture.versions;
    await entity<Model>(
      await putAlias(harness, fixture, {
        alias: 'production',
        versionId: first!.id,
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    const switched = await entity<Model>(
      await putAlias(harness, fixture, {
        alias: 'production',
        versionId: second!.id,
        reason: '評価でWERが改善',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(switched.aliases).toEqual({ production: second!.id });
    await entity<Model>(
      await putAlias(harness, fixture, {
        alias: 'production',
        versionId: second!.id,
        reason: '再送',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    const page = await aliasEvents(harness, fixture);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      alias: 'production',
      previousVersionId: first!.id,
      previousVersion: first!.version,
      versionId: second!.id,
      version: second!.version,
      source: 'web',
      reason: '評価でWERが改善',
      promotionEvaluationId: null,
      actor: {
        userId: fixture.editor.userId,
        displayName: expect.any(String),
        tokenId: null,
      },
    } satisfies Partial<ModelAliasEvent>);
    expect(page.items[1]).toMatchObject({
      previousVersionId: null,
      versionId: first!.id,
    });
  });

  it('DELETEで解除eventを残し、未設定のaliasの解除は404になる', async () => {
    const fixture = await registryFixture(harness);
    await entity(
      await putAlias(harness, fixture, {
        alias: 'staging',
        versionId: fixture.versions[0]!.id,
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    const removed = await request(harness.app, `${fixture.modelPath}/aliases/staging`, {
      method: 'DELETE',
      cookie: fixture.editor.cookie,
      body: { reason: '検証終了' },
    });
    expect(removed.status).toBe(204);
    const missing = await request(harness.app, `${fixture.modelPath}/aliases/staging`, {
      method: 'DELETE',
      cookie: fixture.editor.cookie,
    });
    expect(missing.status).toBe(404);
    const page = await aliasEvents(harness, fixture, '?alias=staging');
    expect(page.items[0]).toMatchObject({
      previousVersionId: fixture.versions[0]!.id,
      versionId: null,
      version: null,
      reason: '検証終了',
    });
    expect(
      (
        await entity<{ items: Model[] }>(
          await request(harness.app, `${fixture.basePath}/models`, {
            cookie: fixture.viewer.cookie,
          }),
          200,
        )
      ).items[0]!.aliases,
    ).toEqual({});
  });

  it('理由が2000文字を超えると422になる', async () => {
    const fixture = await registryFixture(harness);
    const response = await putAlias(harness, fixture, {
      alias: 'production',
      versionId: fixture.versions[0]!.id,
      reason: 'x'.repeat(2001),
      cookie: fixture.editor.cookie,
    });
    expect(response.status).toBe(422);
  });

  it('MLflowのalias設定・解除、版の削除、Registered Modelの削除がそれぞれのsourceでeventを残す', async () => {
    const fixture = await registryFixture(harness);
    const mlflow = (path: string, method: string, body: unknown) =>
      request(harness.app, `${fixture.mlflowBase}/${path}`, {
        method,
        cookie: fixture.editor.cookie,
        body,
      });
    const setAlias = (alias: string, version: string) =>
      mlflow('registered-models/alias', 'POST', {
        name: 'Classifier',
        alias,
        version,
      });
    expect((await setAlias('champion', '1')).status).toBe(200);
    // SDK retries of the same alias call must not grow the history.
    expect((await setAlias('champion', '1')).status).toBe(200);
    expect(
      (
        await mlflow('registered-models/alias', 'DELETE', {
          name: 'Classifier',
          alias: 'champion',
        })
      ).status,
    ).toBe(200);
    expect((await setAlias('candidate', '2')).status).toBe(200);
    expect(
      (
        await mlflow('model-versions/delete', 'DELETE', {
          name: 'Classifier',
          version: '2',
        })
      ).status,
    ).toBe(200);
    expect((await setAlias('production', '3')).status).toBe(200);
    expect((await setAlias('fallback', '3')).status).toBe(200);
    expect(
      (
        await mlflow('registered-models/delete', 'DELETE', {
          name: 'Classifier',
        })
      ).status,
    ).toBe(200);

    const events = (await aliasEvents(harness, fixture)).items.reverse();
    expect(
      events.map((event) => [event.alias, event.source, event.previousVersion, event.version]),
    ).toEqual([
      ['champion', 'mlflow', null, '1'],
      ['champion', 'mlflow', '1', null],
      ['candidate', 'mlflow', null, '2'],
      ['candidate', 'version_deleted', '2', null],
      ['production', 'mlflow', null, '3'],
      ['fallback', 'mlflow', null, '3'],
      ['fallback', 'model_deleted', '3', null],
      ['production', 'model_deleted', '3', null],
    ]);
    expect(events.every((event) => event.reason === '')).toBe(true);
    expect(events.every((event) => event.actor?.userId === fixture.editor.userId)).toBe(true);
  });

  it('eventのUPDATEとDELETEはtriggerで拒否する', async () => {
    const fixture = await registryFixture(harness);
    await entity(
      await putAlias(harness, fixture, {
        alias: 'production',
        versionId: fixture.versions[0]!.id,
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    await expect(
      harness.database.query("UPDATE model_alias_events SET reason='改ざん'"),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(harness.database.query('DELETE FROM model_alias_events')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('viewerとread scopeのtokenは履歴を読めるが変更は403、registry:writeのtokenはsource=apiで記録される', async () => {
    const fixture = await registryFixture(harness);
    const versionId = fixture.versions[0]!.id;
    expect(
      (
        await putAlias(harness, fixture, {
          alias: 'production',
          versionId,
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(403);
    const mint = async (scopes: string[]) =>
      await entity<{ token: string; item: { id: string } }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            name: scopes.join(' '),
            kind: 'personal',
            projectId: fixture.project.id,
            scopes,
          },
        }),
      );
    const reader = await mint(['read']);
    expect(
      (
        await putAlias(harness, fixture, {
          alias: 'production',
          versionId,
          token: reader.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app, `${fixture.modelPath}/aliases/production`, {
          method: 'DELETE',
          token: reader.token,
        })
      ).status,
    ).toBe(403);
    const writer = await mint(['read', 'registry:write']);
    await entity(
      await putAlias(harness, fixture, {
        alias: 'production',
        versionId,
        token: writer.token,
      }),
      200,
    );
    const page = await entity<ModelAliasEventPage>(
      await request(harness.app, `${fixture.modelPath}/alias-events`, {
        token: reader.token,
      }),
      200,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      source: 'api',
      actor: { userId: fixture.editor.userId, tokenId: writer.item.id },
    });
    expect(
      (
        await request(harness.app, `${fixture.modelPath}/alias-events`, {
          cookie: fixture.outsider.cookie,
        })
      ).status,
    ).toBe(403);
  });

  it('別Projectのmodel IDとcursorは404になる', async () => {
    const fixture = await registryFixture(harness);
    const other = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherModel = await entity<Model>(
      await request(harness.app, `/api/projects/${other.id}/models`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other', family: 'qwen2' },
      }),
    );
    const otherVersion = await entity<ModelVersion>(
      await request(harness.app, `/api/projects/${other.id}/models/${otherModel.id}/versions`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {},
      }),
    );
    await entity(
      await request(
        harness.app,
        `/api/projects/${other.id}/models/${otherModel.id}/aliases/production`,
        {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { versionId: otherVersion.id },
        },
      ),
      200,
    );
    const foreignPath = `${fixture.basePath}/models/${otherModel.id}`;
    const administrator = fixture.administrator.cookie;
    expect(
      (
        await request(harness.app, `${foreignPath}/alias-events`, {
          cookie: administrator,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${foreignPath}/aliases/production`, {
          method: 'PUT',
          cookie: administrator,
          body: { versionId: otherVersion.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${foreignPath}/aliases/production`, {
          method: 'DELETE',
          cookie: administrator,
        })
      ).status,
    ).toBe(404);
    // A version of another Model cannot be assigned either.
    expect(
      (
        await putAlias(harness, fixture, {
          alias: 'production',
          versionId: otherVersion.id,
          cookie: fixture.editor.cookie,
        })
      ).status,
    ).toBe(404);
    const foreignEvent = (
      await entity<ModelAliasEventPage>(
        await request(
          harness.app,
          `/api/projects/${other.id}/models/${otherModel.id}/alias-events`,
          {
            cookie: administrator,
          },
        ),
        200,
      )
    ).items[0]!;
    expect(
      (
        await request(harness.app, `${fixture.modelPath}/alias-events?cursor=${foreignEvent.id}`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('2つのtransactionで同時に切り替えても、previous_version_idは前のeventの版と連鎖する', async () => {
    const fixture = await registryFixture(harness);
    const [first, second, third] = fixture.versions;
    const actor = { userId: fixture.editor.userId, tokenId: null };
    const assign = (versionId: string) => ({
      modelId: fixture.model.id,
      alias: 'production',
      versionId,
      actor,
      source: 'api' as const,
      guard: async () => undefined,
    });
    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstAssigned!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => (firstAssigned = resolve));
    const firstTransaction = transaction(harness.database, async (connection) => {
      await assignModelAlias(connection, assign(first!.id));
      firstAssigned();
      await firstMayCommit;
    });
    await firstHoldsLock;
    const secondTransaction = transaction(harness.database, (connection) =>
      assignModelAlias(connection, assign(second!.id)),
    );
    // Release the first transaction only after the second is blocked on the Model lock.
    while (
      !(
        await harness.database.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
          AND query LIKE 'SELECT project_id FROM models WHERE id=$1 FOR UPDATE%'`,
        )
      ).rowCount
    )
      await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([firstTransaction, secondTransaction]);
    await Promise.all(
      [third!.id, first!.id, second!.id].map((versionId) =>
        putAlias(harness, fixture, {
          alias: 'production',
          versionId,
          cookie: fixture.editor.cookie,
        }),
      ),
    );

    const events = (await aliasEvents(harness, fixture)).items.reverse();
    expect(events[0]).toMatchObject({
      previousVersionId: null,
      versionId: first!.id,
    });
    expect(events[1]).toMatchObject({
      previousVersionId: first!.id,
      versionId: second!.id,
    });
    for (let index = 1; index < events.length; index += 1)
      expect(events[index]!.previousVersionId).toBe(events[index - 1]!.versionId);
    const current = await harness.database.query(
      "SELECT version_id FROM model_aliases WHERE alias='production'",
    );
    expect(current.rows[0].version_id).toBe(events.at(-1)!.versionId);
  });

  it('cursorで最新から辿ると重複も欠落もない', async () => {
    const fixture = await registryFixture(harness);
    for (let index = 0; index < 7; index += 1)
      await entity(
        await putAlias(harness, fixture, {
          alias: 'production',
          versionId: fixture.versions[index % 3]!.id,
          reason: `change ${index}`,
          cookie: fixture.editor.cookie,
        }),
        200,
      );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelAliasEventPage = await aliasEvents(
        harness,
        fixture,
        `?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.items.map((event) => event.reason));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0].map((index) => `change ${index}`));
    expect(
      (
        await request(harness.app, `${fixture.modelPath}/alias-events?limit=201`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(422);
  });
});

describe.skipIf(!testDatabaseUrl)('alias履歴の移行（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({ applyMigrations: false });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('移行時点の既存aliasをmigration snapshotの初期eventとして残す', async () => {
    await applyMigrationsBefore(harness.database, '016_model_alias_events.sql');
    const legacy = await harness.database.query(`
      WITH project AS (INSERT INTO projects(name) VALUES('Legacy') RETURNING id),
      model AS (INSERT INTO models(project_id,name,family) SELECT id,'Legacy model','qwen2' FROM project RETURNING id,project_id),
      version AS (INSERT INTO model_versions(model_id,project_id,version) SELECT id,project_id,'1' FROM model RETURNING id,model_id),
      alias AS (INSERT INTO model_aliases(model_id,alias,version_id) SELECT model_id,'production',id FROM version RETURNING model_id)
      SELECT v.id AS version_id,v.model_id FROM version v,alias`);
    await migrate(harness.database);
    const events = await harness.database.query(
      'SELECT model_id,alias,previous_version_id,version_id,source,reason,actor_user_id FROM model_alias_events',
    );
    expect(events.rows).toEqual([
      {
        model_id: legacy.rows[0].model_id,
        alias: 'production',
        previous_version_id: null,
        version_id: legacy.rows[0].version_id,
        source: 'api',
        reason: 'migration snapshot',
        actor_user_id: null,
      },
    ]);
  });
});
