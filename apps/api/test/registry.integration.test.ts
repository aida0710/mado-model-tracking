import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Code,
  Dataset,
  DatasetVersion,
  LineageGraph,
  Model,
  ModelVersion,
  PluginConnection,
  PluginEvent,
  Project,
  Run,
  RunKind,
} from '@mmt/contracts';
import { transaction } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { reserveModelVersion } from '../src/repositories/modelVersionNumbering.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { applyMigrationsBefore } from './migrationFixtures.js';
import { executionFixture, projectFixture } from './fixtures.js';
import { modelFixture, type VersionResponse } from './mlflow-models-fixtures.js';

describe.skipIf(!testDatabaseUrl)('Project認可と不変なRegistry（独立PostgreSQL）', () => {
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

  it('未認証は401になり、viewerは読むだけでeditorはRunとRegistryを作成できる', async () => {
    const fixture = await projectFixture(harness);
    expect((await request(harness.app, `${fixture.basePath}/runs`)).status).toBe(401);
    expect(
      (await request(harness.app, `${fixture.basePath}/runs`, { cookie: fixture.viewer.cookie }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/models`, {
          method: 'POST',
          cookie: fixture.viewer.cookie,
          body: { name: 'Forbidden', family: 'qwen2' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/runs`, {
          method: 'POST',
          cookie: fixture.viewer.cookie,
          body: { experimentId: fixture.experiment.id, name: 'Forbidden', kind: 'training' },
        })
      ).status,
    ).toBe(403);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, name: 'Allowed', kind: 'training' },
      }),
    );
    expect(run.projectId).toBe(fixture.project.id);
    const experiments = await entity<{ items: { runCount: number }[] }>(
      await request(harness.app, `${fixture.basePath}/experiments`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(experiments.items[0]!.runCount).toBe(1);
    expect(
      (await request(harness.app, `${fixture.basePath}/runs`, { cookie: fixture.outsider.cookie }))
        .status,
    ).toBe(403);
  });

  it('editorはメンバー権限を変更できず、最後のadminの降格も拒否する', async () => {
    const fixture = await projectFixture(harness);
    const endpoint = `${fixture.basePath}/members/${fixture.viewer.userId}`;
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          body: { role: 'admin' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/members/${fixture.administrator.userId}`, {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { role: 'viewer' },
        })
      ).status,
    ).toBe(409);
    const members = await entity<{ items: { user: { id: string }; role: string }[] }>(
      await request(harness.app, `${fixture.basePath}/members`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(members.items.find((member) => member.user.id === fixture.editor.userId)?.role).toBe(
      'editor',
    );
  });

  it('Cookieの変更要求はOriginを確認し、productionのdevelopment loginを拒否する', async () => {
    const fixture = await projectFixture(harness);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/experiments`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          headers: { Origin: 'https://attacker.example' },
          body: { name: 'CSRF' },
        })
      ).status,
    ).toBe(403);
    const { loadConfig } = await import('../src/config.js');
    expect(() =>
      loadConfig({
        MMT_DATABASE_URL: testDatabaseUrl,
        AUTH_MODE: 'development',
        NODE_ENV: 'production',
      }),
    ).toThrow('forbidden');
    expect(
      (
        await request(harness.app, '/api/auth/dev-login', {
          method: 'POST',
          body: { email: 'editor@localhost', isAdmin: true },
        })
      ).status,
    ).toBe(422);
  });

  it('Qwen2用コードとQwen3モデル、未対応taskTypeの組合せを保存前に拒否する', async () => {
    const fixture = await executionFixture(harness);
    const qwen3 = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Qwen3 Test', family: 'qwen3' },
      }),
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/models/${qwen3.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { version: 'bad-default', defaultCodeVersionId: fixture.codeVersion.id },
        })
      ).status,
    ).toBe(422);
    const qwen3Version = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${qwen3.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'base' },
      }),
    );
    const create = (attributes: object) =>
      request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Mismatch',
          kind: 'inference',
          ...attributes,
        },
      });
    expect(
      (await create({ modelVersionId: qwen3Version.id, codeVersionId: fixture.codeVersion.id }))
        .status,
    ).toBe(422);
    expect(
      (await create({ modelVersionId: fixture.modelVersion.id, kind: 'evaluation' })).status,
    ).toBe(422);
    const count = await harness.database.query('SELECT count(*)::int AS count FROM runs');
    expect(count.rows[0].count).toBe(0);
  });

  it('Runは開始時のModelVersionとCodeVersionを保存し、aliasが動いても変わらない', async () => {
    const fixture = await executionFixture(harness);
    const setAlias = (versionId: string) =>
      request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/aliases/latest`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        body: { versionId },
      });
    await entity(await setAlias(fixture.modelVersion.id), 200);
    const run = await fixture.newRun();
    const newer = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'next', parentModelVersionIds: [fixture.modelVersion.id] },
      }),
    );
    await entity(await setAlias(newer.id), 200);
    const stored = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(stored.modelVersionId).toBe(fixture.modelVersion.id);
    expect(stored.codeVersionId).toBe(fixture.codeVersion.id);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { modelVersionId: newer.id },
        })
      ).status,
    ).toBe(422);
  });

  it('同じバージョン名は409になり、DBに直接UPDATEしてもバージョンは変更できない', async () => {
    const fixture = await executionFixture(harness);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { version: 'base' },
        })
      ).status,
    ).toBe(409);
    await expect(
      harness.database.query('UPDATE model_versions SET metadata=$2 WHERE id=$1', [
        fixture.modelVersion.id,
        '{}',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.database.query('UPDATE code_versions SET version=$2 WHERE id=$1', [
        fixture.codeVersion.id,
        'changed',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const unpinnedCode = {
      version: 'mutable',
      source: { kind: 'git', url: 'https://example.test/repo.git', commit: 'main' },
      entrypoint: ['python', 'main.py'],
      supportedModelFamilies: ['qwen2'],
      taskTypes: ['inference'],
    };
    expect(
      (
        await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: unpinnedCode,
        })
      ).status,
    ).toBe(422);
  });

  it.each([
    {
      conflict: '編集した子孫と削除した祖先',
      files: { 'folder/new.py': 'pass' },
      deletedFiles: ['folder'],
    },
    {
      conflict: '編集した祖先と削除した子孫',
      files: { folder: 'pass' },
      deletedFiles: ['folder/old.py'],
    },
    {
      conflict: '削除した祖先と子孫',
      deletedFiles: ['folder', 'folder/old.py'],
    },
    {
      conflict: '逆順に削除した子孫と祖先',
      deletedFiles: ['folder/old.py', 'folder'],
    },
  ])(
    '$conflictのバージョン登録は422になり、コードバージョン・Run・Jobを作らない',
    async ({ conflict: _conflict, ...overlay }) => {
      const fixture = await projectFixture(harness);
      const code = await entity<Code>(
        await request(harness.app, `${fixture.basePath}/codes`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name: 'Conflicting paths' },
        }),
      );
      const versionsPath = `${fixture.basePath}/codes/${code.id}/versions`;
      const response = await request(harness.app, versionsPath, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'invalid-overlay',
          source: {
            kind: 'git',
            url: 'https://example.test/repo.git',
            commit: 'a'.repeat(40),
            ...overlay,
          },
          entrypoint: ['python', 'folder/new.py'],
          supportedModelFamilies: ['qwen2'],
          taskTypes: ['training'],
        },
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'invalid_request' });
      expect(
        await entity(
          await request(harness.app, versionsPath, { cookie: fixture.editor.cookie }),
          200,
        ),
      ).toEqual({ items: [] });
      const persisted = await harness.database.query(
        `SELECT
         (SELECT count(*)::int FROM code_versions) AS code_versions,
         (SELECT count(*)::int FROM runs) AS runs,
         (SELECT count(*)::int FROM jobs) AS jobs`,
      );
      expect(persisted.rows).toEqual([{ code_versions: 0, runs: 0, jobs: 0 }]);
    },
  );

  it('別projectの実験・親Run・モデル・コード・データセット・Artifact・親バージョンは参照できない', async () => {
    const fixture = await executionFixture(harness);
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherPath = `/api/projects/${other.id}`;
    const otherExperiment = await entity<{ id: string }>(
      await request(harness.app, `${otherPath}/experiments`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Experiment' },
      }),
    );
    const otherRun = await entity<Run>(
      await request(harness.app, `${otherPath}/runs`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { experimentId: otherExperiment.id, name: 'Other Run', kind: 'processing' },
      }),
    );
    const otherDataset = await entity<Dataset>(
      await request(harness.app, `${otherPath}/datasets`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Dataset' },
      }),
    );
    const otherDatasetVersion = await entity<DatasetVersion>(
      await request(harness.app, `${otherPath}/datasets/${otherDataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { version: 'v1', uri: 'file:///example', digest: 'test' },
      }),
    );
    const localDataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Local Dataset' },
      }),
    );
    const otherArtifact = await entity<{ id: string }>(
      await request(harness.app, `${otherPath}/artifacts?path=weights.bin`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        binary: 'weights',
      }),
    );
    const attempts = [
      { experimentId: otherExperiment.id },
      { parentRunId: otherRun.id },
      { inputDatasetVersionIds: [otherDatasetVersion.id] },
    ];
    for (const invalidReference of attempts)
      expect(
        (
          await request(harness.app, `${fixture.basePath}/runs`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: {
              experimentId: fixture.experiment.id,
              name: 'Forbidden reference',
              kind: 'processing',
              ...invalidReference,
            },
          })
        ).status,
      ).toBe(404);
    expect(
      (
        await request(harness.app, `${otherPath}/runs`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: {
            experimentId: otherExperiment.id,
            name: 'Cross model',
            kind: 'inference',
            modelVersionId: fixture.modelVersion.id,
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${otherPath}/runs`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: {
            experimentId: otherExperiment.id,
            name: 'Cross code',
            kind: 'inference',
            codeVersionId: fixture.codeVersion.id,
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${otherPath}/models/${fixture.model.id}/versions`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { version: 'cross' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { version: 'cross-artifact', artifactId: otherArtifact.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/datasets/${localDataset.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            version: 'bad-parent',
            uri: 'file:///local',
            digest: 'test',
            parentDatasetVersionIds: [otherDatasetVersion.id],
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/datasets/${localDataset.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            version: 'bad-source',
            uri: 'file:///local',
            digest: 'test',
            sourceRunId: otherRun.id,
          },
        })
      ).status,
    ).toBe(404);
  });

  it('出力DatasetVersionとモデルの由来を同じprojectのlineageに保存する', async () => {
    const fixture = await executionFixture(harness);
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Corpus' },
      }),
    );
    const input = await entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'v1', uri: 'file:///corpus', digest: 'v1' },
      }),
    );
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Fine tuning',
          kind: 'finetuning',
          modelVersionId: fixture.modelVersion.id,
          inputDatasetVersionIds: [input.id],
        },
      }),
    );
    const output = await entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v2',
          uri: 'file:///output',
          digest: 'v2',
          sourceRunId: run.id,
          parentDatasetVersionIds: [input.id],
        },
      }),
    );
    const derived = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'finetuned',
          sourceRunId: run.id,
          parentModelVersionIds: [fixture.modelVersion.id],
        },
      }),
    );
    const stored = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(stored.outputDatasetVersionIds).toEqual([output.id]);
    const graph = await entity<{
      nodes: { id: string }[];
      edges: { source: string; target: string; relation: string }[];
    }>(
      await request(harness.app, `${fixture.basePath}/lineage`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(graph.edges).toContainEqual({
      source: run.id,
      target: derived.id,
      relation: 'outputModel',
    });
    expect(graph.edges).toContainEqual({
      source: input.id,
      target: output.id,
      relation: 'parentDataset',
    });
    expect(graph.edges).toContainEqual({ source: run.id, target: output.id, relation: 'output' });
    await expect(
      harness.database.query('UPDATE dataset_versions SET digest=$2 WHERE id=$1', [
        output.id,
        'changed',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('metricsは数値とISO日時になり、遅着した小さいstepはlatestMetricsを巻き戻さない', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun();
    for (const [step, value] of [
      [5, 0.5],
      [1, 10],
    ])
      expect(
        (
          await request(harness.app, `${fixture.basePath}/runs/${run.id}/metrics`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { metrics: [{ name: 'loss', value, step, timestamp: '2026-10-08T00:00:00Z' }] },
          })
        ).status,
      ).toBe(204);
    const points = await entity<{ items: { step: number; timestamp: string }[] }>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}/metrics`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(points.items.map((point) => typeof point.step)).toEqual(['number', 'number']);
    expect(points.items[0]!.timestamp).toBe('2026-10-08T00:00:00.000Z');
    const stored = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(stored.latestMetrics.loss).toBe(0.5);
    await entity(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { parameters: { epochs: 1 }, tags: { first: 'one' } },
      }),
      200,
    );
    const merged = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { parameters: { batch: 2 }, tags: { second: 'two' } },
      }),
      200,
    );
    expect(merged.parameters).toEqual({ epochs: 1, batch: 2 });
    expect(merged.tags).toEqual({ first: 'one', second: 'two' });
  });

  it('Personal/service tokenはhashだけを保存し、scope・project・失効・現在のmembershipを確認する', async () => {
    const fixture = await projectFixture(harness);
    const token = await entity<{ token: string; item: { id: string } }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'Read only',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    const stored = await harness.database.query('SELECT token_hash FROM api_tokens WHERE id=$1', [
      token.item.id,
    ]);
    expect(stored.rows[0].token_hash).not.toBe(token.token);
    expect(stored.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (await request(harness.app, `${fixture.basePath}/runs`, { token: token.token })).status,
    ).toBe(200);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/experiments`, {
          method: 'POST',
          token: token.token,
          body: { name: 'No scope' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          token: token.token,
          body: {
            name: 'Escalate',
            kind: 'personal',
            projectId: fixture.project.id,
            scopes: ['admin'],
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            name: 'Service forbidden',
            kind: 'service',
            projectId: fixture.project.id,
            scopes: ['read'],
          },
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
    expect(
      (await request(harness.app, `/api/projects/${other.id}/runs`, { token: token.token })).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app, `/api/tokens/${token.item.id}`, {
          method: 'DELETE',
          cookie: fixture.editor.cookie,
        })
      ).status,
    ).toBe(204);
    expect(
      (await request(harness.app, `${fixture.basePath}/runs`, { token: token.token })).status,
    ).toBe(401);
    const another = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: {
          name: 'Membership',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    await harness.database.query('DELETE FROM project_members WHERE user_id=$1 AND project_id=$2', [
      fixture.viewer.userId,
      fixture.project.id,
    ]);
    expect(
      (await request(harness.app, `${fixture.basePath}/runs`, { token: another.token })).status,
    ).toBe(401);
  });
});

describe.skipIf(!testDatabaseUrl)('出力モデル登録とバージョンの自動採番（独立PostgreSQL）', () => {
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

  type Fixture = Awaited<ReturnType<typeof projectFixture>>;
  async function createRun(fixture: Fixture, kind: RunKind = 'training') {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, name: `${kind} output`, kind },
      }),
    );
  }
  function registerVersion(fixture: Fixture, modelId: string, body: Record<string, unknown> = {}) {
    return request(harness.app, `${fixture.basePath}/models/${modelId}/versions`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body,
    });
  }
  async function readRun(fixture: Fixture, runId: string) {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  it('versionを省略した連続登録は1,2,3になり、明示した整数バージョンの後から続き、整数でないバージョンは採番に含めない', async () => {
    const fixture = await executionFixture(harness);
    const numbered: string[] = [];
    for (let index = 0; index < 3; index += 1)
      numbered.push(
        (await entity<ModelVersion>(await registerVersion(fixture, fixture.model.id))).version,
      );
    expect(numbered).toEqual(['1', '2', '3']);
    await entity(await registerVersion(fixture, fixture.model.id, { version: '10' }));
    await entity(await registerVersion(fixture, fixture.model.id, { version: 'v99' }));
    const next = await entity<ModelVersion>(await registerVersion(fixture, fixture.model.id));
    expect(next.version).toBe('11');
    const duplicate = await registerVersion(fixture, fixture.model.id, { version: '2' });
    expect(duplicate.status).toBe(409);
    const afterConflict = await entity<ModelVersion>(
      await registerVersion(fixture, fixture.model.id),
    );
    expect(afterConflict.version).toBe('12');
  });

  it('同時の登録でもUNIQUE違反なく別々のバージョンを払い出す', async () => {
    const fixture = await executionFixture(harness);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => registerVersion(fixture, fixture.model.id)),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(5).fill(201));
    const versions = await Promise.all(responses.map((response) => entity<ModelVersion>(response)));
    expect(versions.map((version) => Number(version.version)).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('nameの完全一致でModelを1件だけ返す', async () => {
    const fixture = await executionFixture(harness);
    const byName = async (name: string) =>
      entity<{ items: Model[] }>(
        await request(harness.app, `${fixture.basePath}/models?${new URLSearchParams({ name })}`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      );
    expect((await byName('Qwen2 Test')).items.map((model) => model.id)).toEqual([fixture.model.id]);
    expect((await byName('Qwen2')).items).toEqual([]);
    expect((await byName('qwen2 test')).items).toEqual([]);
  });

  it('ネイティブとMLflowの登録を交互にしても重複せず、削除したバージョンを再利用せずRunの出力から外す', async () => {
    const fixture = await modelFixture(harness);
    await entity(await fixture.createRegistered('Classifier'), 200);
    const ready = await fixture.readyModel();
    const [model] = (
      await entity<{ items: Model[] }>(
        await request(harness.app, `${fixture.basePath}/models?name=Classifier`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      )
    ).items;
    const registerMlflow = async () =>
      (await entity<VersionResponse>(await fixture.register(ready.model.info.model_id), 200))
        .model_version.version;
    const registerNative = async () =>
      (
        await entity<ModelVersion>(
          await registerVersion(fixture, model!.id, { sourceRunId: fixture.run.id }),
        )
      ).version;
    expect([
      await registerMlflow(),
      await registerNative(),
      await registerMlflow(),
      await registerNative(),
    ]).toEqual(['1', '2', '3', '4']);
    expect(
      (
        await request(fixture.app, `${fixture.versionEndpoint}/delete`, {
          method: 'DELETE',
          cookie: fixture.editor.cookie,
          body: { name: 'Classifier', version: '4' },
        })
      ).status,
    ).toBe(200);
    expect([await registerNative(), await registerMlflow()]).toEqual(['5', '6']);
    const versions = await entity<{ items: ModelVersion[] }>(
      await request(harness.app, `${fixture.basePath}/models/${model!.id}/versions`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    const idsByVersion = new Map(versions.items.map((version) => [version.version, version.id]));
    const activeIds = ['1', '2', '3', '5', '6'].map((version) => idsByVersion.get(version));
    expect((await readRun(fixture, fixture.run.id)).outputModelVersionIds).toEqual(activeIds);
    const listed = await entity<{ items: Run[] }>(
      await request(harness.app, `${fixture.basePath}/runs`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(listed.items.find((run) => run.id === fixture.run.id)?.outputModelVersionIds).toEqual(
      activeIds,
    );
    const graph = await entity<LineageGraph>(
      await request(harness.app, `${fixture.basePath}/lineage`, { cookie: fixture.viewer.cookie }),
      200,
    );
    const outputs = graph.edges
      .filter((edge) => edge.relation === 'outputModel' && edge.source === fixture.run.id)
      .map((edge) => edge.target);
    expect(outputs).toEqual(expect.arrayContaining(activeIds));
    expect(outputs).not.toContain(idsByVersion.get('4'));
  });

  it('inference Runと削除済みRunをsourceRunIdにすると422になり、バージョンもcounterも残さない', async () => {
    const fixture = await executionFixture(harness);
    const inference = await fixture.newRun();
    const rejectedKind = await registerVersion(fixture, fixture.model.id, {
      sourceRunId: inference.id,
    });
    expect(rejectedKind.status).toBe(422);
    expect(((await rejectedKind.json()) as { code: string }).code).toBe('output_model_kind');
    const training = await createRun(fixture);
    expect(
      (
        await request(
          harness.app,
          `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow/runs/delete`,
          { method: 'POST', cookie: fixture.editor.cookie, body: { run_id: training.id } },
        )
      ).status,
    ).toBe(200);
    const rejectedDeleted = await registerVersion(fixture, fixture.model.id, {
      sourceRunId: training.id,
    });
    expect(rejectedDeleted.status).toBe(422);
    expect(((await rejectedDeleted.json()) as { code: string }).code).toBe('source_run_deleted');
    const next = await entity<ModelVersion>(await registerVersion(fixture, fixture.model.id));
    expect(next.version).toBe('1');
  });

  it('終端Runへの遅れた登録はoutboxへRun eventを再送し、outputModelVersionIdsを含める', async () => {
    const fixture = await executionFixture(harness);
    await entity<PluginConnection>(
      await request(harness.app, `${fixture.basePath}/plugins`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Lineage',
          baseUrl: 'http://127.0.0.1:4999',
          tokenEnv: 'MMT_TEST_PLUGIN_TOKEN',
        },
      }),
    );
    const run = await createRun(fixture, 'finetuning');
    for (const status of ['running', 'finished'])
      await entity(
        await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status },
        }),
        200,
      );
    const version = await entity<ModelVersion>(
      await registerVersion(fixture, fixture.model.id, { sourceRunId: run.id }),
    );
    const refreshed = await harness.database.query<{ event: PluginEvent }>(
      "SELECT event FROM plugin_outbox WHERE event->'run'->'outputModelVersionIds' @> $1::jsonb",
      [JSON.stringify([version.id])],
    );
    expect(refreshed.rows).toHaveLength(1);
    expect(refreshed.rows[0]!.event.type).toBe('run.finished');
    expect((await readRun(fixture, run.id)).outputModelVersionIds).toEqual([version.id]);
  });

  it('Runの作成者として動くsystem actorは作成者の編集権限で登録し、権限を失うと403', async () => {
    const fixture = await executionFixture(harness);
    const run = await createRun(fixture);
    const registerAsRunCreator = (sourceRunId: string | null) =>
      transaction(harness.database, (connection) =>
        harness.services.registry.registerModelVersion(connection, {
          projectId: fixture.project.id,
          modelId: fixture.model.id,
          sourceRunId,
          parentVersionIds: [],
          metadata: {},
          actor: { type: 'runCreator' },
        }),
      );
    expect((await registerAsRunCreator(run.id)).version).toBe('1');
    await expect(registerAsRunCreator(null)).rejects.toMatchObject({
      status: 422,
      code: 'source_run_required',
    });
    await harness.database.query(
      "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [fixture.project.id, fixture.editor.userId],
    );
    await expect(registerAsRunCreator(run.id)).rejects.toMatchObject({ status: 403 });
    expect((await readRun(fixture, run.id)).outputModelVersionIds).toHaveLength(1);
  });
});

describe.skipIf(!testDatabaseUrl)('バージョンcounterの移行（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({ applyMigrations: false });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('011は整数のバージョンの最大+1とMLflow側counterの大きい方から始め、以後のMLflow登録と重複しない', async () => {
    await applyMigrationsBefore(harness.database, '011_run_output_models.sql');
    const project = (
      await harness.database.query<{ id: string }>(
        "INSERT INTO projects(name) VALUES('Legacy') RETURNING id",
      )
    ).rows[0]!;
    const createModel = async (name: string, versions: string[], mlflowNextVersion?: number) => {
      const model = (
        await harness.database.query<{ id: string }>(
          "INSERT INTO models(project_id,name,family) VALUES($1,$2,'legacy') RETURNING id",
          [project.id, name],
        )
      ).rows[0]!;
      for (const version of versions)
        await harness.database.query(
          'INSERT INTO model_versions(model_id,project_id,version) VALUES($1,$2,$3)',
          [model.id, project.id, version],
        );
      if (mlflowNextVersion)
        await harness.database.query(
          'INSERT INTO mlflow_registered_model_metadata(model_id,project_id,next_version) VALUES($1,$2,$3)',
          [model.id, project.id, mlflowNextVersion],
        );
      return model.id;
    };
    // MLflow already numbered 1..9 for this Model and some versions were deleted afterwards.
    const mlflowAhead = await createModel('MLflow ahead', ['3', 'v9', '12345678901234567890'], 10);
    const nativeAhead = await createModel('Native ahead', ['5', '01'], 2);
    const empty = await createModel('Empty', []);
    await migrate(harness.database);
    const counters = await harness.database.query<{ id: string; next_version: string }>(
      'SELECT id,next_version::text FROM models',
    );
    const counterById = new Map(counters.rows.map((row) => [row.id, row.next_version]));
    expect([mlflowAhead, nativeAhead, empty].map((id) => counterById.get(id))).toEqual([
      '10',
      '6',
      '1',
    ]);
    const reserved = await transaction(harness.database, async (connection) => [
      await reserveModelVersion(connection, { projectId: project.id, modelId: mlflowAhead }),
      await reserveModelVersion(connection, { projectId: project.id, modelId: mlflowAhead }),
    ]);
    expect(reserved).toEqual(['10', '11']);
  });
});
