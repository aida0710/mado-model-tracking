import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Dataset, DatasetVersion, Model, ModelVersion, Project, Run } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture, projectFixture } from './fixtures.js';

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

  it('同じ版名は409になり、DBに直接UPDATEしても版は変更できない', async () => {
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

  it('別projectの実験・親Run・モデル・コード・データセット・Artifact・親版は参照できない', async () => {
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
