import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Dataset,
  DatasetVersion,
  Experiment,
  Job,
  Model,
  ModelVersion,
  Project,
  Run,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

type Fixture = Awaited<ReturnType<typeof executionFixture>>;

describe.skipIf(!testDatabaseUrl)('Registryのライフサイクル（独立PostgreSQL）', () => {
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

  async function patch(
    endpoint: string,
    options: { cookie: string; body: unknown },
  ): Promise<Response> {
    return request(harness.app, endpoint, { method: 'PATCH', ...options });
  }

  async function auditEvents(action: string) {
    return (
      await harness.database.query<{ outcome: string; resource_id: string; details: object }>(
        'SELECT outcome,resource_id,details FROM audit_events WHERE action=$1 ORDER BY occurred_at,id',
        [action],
      )
    ).rows;
  }

  async function datasetWithVersion(fixture: Fixture, name = 'Corpus') {
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name },
      }),
    );
    const version = await entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'v1', uri: `file:///${name}`, digest: `${name}-v1` },
      }),
    );
    return { dataset, version };
  }

  function runWithInputs(fixture: Fixture, inputDatasetVersionIds: string[]) {
    return request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        experimentId: fixture.experiment.id,
        name: 'Fine tuning',
        kind: 'finetuning',
        modelVersionId: fixture.modelVersion.id,
        inputDatasetVersionIds,
      },
    });
  }

  // A Project the fixture's editor cannot see, holding the same kinds of entities.
  async function otherProject(fixture: Fixture) {
    const project = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const basePath = `/api/projects/${project.id}`;
    const cookie = fixture.administrator.cookie;
    const model = await entity<Model>(
      await request(harness.app, `${basePath}/models`, {
        method: 'POST',
        cookie,
        body: { name: 'Other Model', family: 'qwen2' },
      }),
    );
    const version = await entity<ModelVersion>(
      await request(harness.app, `${basePath}/models/${model.id}/versions`, {
        method: 'POST',
        cookie,
        body: { version: 'other' },
      }),
    );
    const experiment = await entity<Experiment>(
      await request(harness.app, `${basePath}/experiments`, {
        method: 'POST',
        cookie,
        body: { name: 'Other Experiment' },
      }),
    );
    const dataset = await entity<Dataset>(
      await request(harness.app, `${basePath}/datasets`, {
        method: 'POST',
        cookie,
        body: { name: 'Other Corpus' },
      }),
    );
    return { model, version, experiment, dataset };
  }

  it('editorはModelの説明を変えられ、単体取得とネストした版の取得に反映され、監査に残る', async () => {
    const fixture = await executionFixture(harness);
    const updated = await entity<Model>(
      await patch(`${fixture.basePath}/models/${fixture.model.id}`, {
        cookie: fixture.editor.cookie,
        body: { description: '社内コーパスで学習した系列' },
      }),
      200,
    );
    expect(updated).toMatchObject({
      id: fixture.model.id,
      name: fixture.model.name,
      family: 'qwen2',
      description: '社内コーパスで学習した系列',
      latestVersion: 'base',
    });
    const fetched = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(fetched).toEqual(updated);
    const version = await entity<ModelVersion>(
      await request(
        harness.app,
        `${fixture.basePath}/models/${fixture.model.id}/versions/${fixture.modelVersion.id}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(version).toEqual(fixture.modelVersion);
    expect(await auditEvents('model.update')).toEqual([
      {
        outcome: 'success',
        resource_id: fixture.model.id,
        details: { fields: ['description'] },
      },
    ]);
  });

  it('名前・系列の変更や空のbodyは422で、Modelは変わらない', async () => {
    const fixture = await executionFixture(harness);
    for (const body of [{}, { name: 'Renamed' }, { family: 'llama' }]) {
      const response = await patch(`${fixture.basePath}/models/${fixture.model.id}`, {
        cookie: fixture.editor.cookie,
        body,
      });
      expect(response.status).toBe(422);
    }
    const fetched = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(fetched).toMatchObject({ name: fixture.model.name, family: 'qwen2', description: '' });
  });

  it('viewerの変更は403で監査にdeniedが残り、値は変わらない', async () => {
    const fixture = await executionFixture(harness);
    const { dataset } = await datasetWithVersion(fixture);
    const attempts = [
      [`${fixture.basePath}/models/${fixture.model.id}`, { description: 'x' }],
      [`${fixture.basePath}/experiments/${fixture.experiment.id}`, { name: 'x' }],
      [`${fixture.basePath}/datasets/${dataset.id}`, { archived: true }],
    ] as const;
    for (const [endpoint, body] of attempts)
      expect((await patch(endpoint, { cookie: fixture.viewer.cookie, body })).status).toBe(403);
    for (const action of ['model.update', 'experiment.update', 'dataset.update'])
      expect((await auditEvents(action)).map((event) => event.outcome)).toEqual(['denied']);
    const stored = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(stored.archivedAt).toBeNull();
  });

  it('Experimentの名前と説明を変えられ、Project内の重複は409、別Projectの同名は許す', async () => {
    const fixture = await executionFixture(harness);
    const other = await otherProject(fixture);
    const second = await entity<Experiment>(
      await request(harness.app, `${fixture.basePath}/experiments`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Second Experiment' },
      }),
    );
    const duplicate = await patch(`${fixture.basePath}/experiments/${second.id}`, {
      cookie: fixture.editor.cookie,
      body: { name: fixture.experiment.name },
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'resource_already_exists' });

    await fixture.newRun();
    const renamed = await entity<Experiment>(
      await patch(`${fixture.basePath}/experiments/${fixture.experiment.id}`, {
        cookie: fixture.editor.cookie,
        body: { name: other.experiment.name, description: '評価用' },
      }),
      200,
    );
    expect(renamed).toMatchObject({
      id: fixture.experiment.id,
      name: 'Other Experiment',
      description: '評価用',
      runCount: 1,
    });
    // Sending the current name again is not a conflict with itself.
    await entity(
      await patch(`${fixture.basePath}/experiments/${fixture.experiment.id}`, {
        cookie: fixture.editor.cookie,
        body: { name: 'Other Experiment' },
      }),
      200,
    );
    const fetched = await entity<Experiment>(
      await request(harness.app, `${fixture.basePath}/experiments/${fixture.experiment.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(fetched).toMatchObject({ name: 'Other Experiment', description: '評価用' });
    const events = await auditEvents('experiment.update');
    expect(events.map((event) => event.outcome)).toEqual(['denied', 'success', 'success']);
    expect(events[1]!.details).toEqual({
      fields: ['name', 'description'],
      name: 'Other Experiment',
      previousName: 'Test Experiment',
    });
  });

  it('MLflowで削除したExperimentは取得が404、変更が409', async () => {
    const fixture = await executionFixture(harness);
    await harness.database.query(
      "UPDATE experiments SET lifecycle_stage='deleted' WHERE id=$1",
      [fixture.experiment.id],
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/experiments/${fixture.experiment.id}`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await patch(`${fixture.basePath}/experiments/${fixture.experiment.id}`, {
          cookie: fixture.editor.cookie,
          body: { description: 'x' },
        })
      ).status,
    ).toBe(409);
  });

  it('archiveしたDatasetの版は新しいRunの入力で422になり、既存Runの参照とJob作成は残る', async () => {
    const fixture = await executionFixture(harness);
    const { dataset, version } = await datasetWithVersion(fixture);
    const existing = await entity<Run>(await runWithInputs(fixture, [version.id]));

    const archived = await entity<Dataset>(
      await patch(`${fixture.basePath}/datasets/${dataset.id}`, {
        cookie: fixture.editor.cookie,
        body: { archived: true },
      }),
      200,
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.latestVersion).toBe('v1');

    const refused = await runWithInputs(fixture, [version.id]);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'dataset_archived' });

    const kept = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${existing.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(kept.inputDatasetVersionIds).toEqual([version.id]);
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: existing.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    expect(job.runId).toBe(existing.id);
    // The version itself stays readable and unchanged.
    const versions = await entity<{ items: DatasetVersion[] }>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(versions.items).toEqual([version]);
  });

  it('archiveを繰り返しても最初の日時のまま、解除すると再び新しいRunの入力に使える', async () => {
    const fixture = await executionFixture(harness);
    const { dataset, version } = await datasetWithVersion(fixture);
    const first = await entity<Dataset>(
      await patch(`${fixture.basePath}/datasets/${dataset.id}`, {
        cookie: fixture.editor.cookie,
        body: { archived: true },
      }),
      200,
    );
    const again = await entity<Dataset>(
      await patch(`${fixture.basePath}/datasets/${dataset.id}`, {
        cookie: fixture.editor.cookie,
        body: { archived: true, description: '旧コーパス' },
      }),
      200,
    );
    expect(again.archivedAt).toBe(first.archivedAt);
    expect(again.description).toBe('旧コーパス');

    const restored = await entity<Dataset>(
      await patch(`${fixture.basePath}/datasets/${dataset.id}`, {
        cookie: fixture.editor.cookie,
        body: { archived: false },
      }),
      200,
    );
    expect(restored.archivedAt).toBeNull();
    await entity<Run>(await runWithInputs(fixture, [version.id]));
    expect((await auditEvents('dataset.update')).map((event) => event.details)).toEqual([
      { fields: ['archived'], archived: true },
      { fields: ['archived', 'description'], archived: true },
      { fields: ['archived'], archived: false },
    ]);
  });

  it('Dataset一覧はarchivedで絞り込め、省略すると全件を返す', async () => {
    const fixture = await executionFixture(harness);
    const active = await datasetWithVersion(fixture, 'Active');
    const old = await datasetWithVersion(fixture, 'Old');
    await entity(
      await patch(`${fixture.basePath}/datasets/${old.dataset.id}`, {
        cookie: fixture.editor.cookie,
        body: { archived: true },
      }),
      200,
    );
    async function names(query: string) {
      const page = await entity<{ items: Dataset[] }>(
        await request(harness.app, `${fixture.basePath}/datasets${query}`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      );
      return page.items.map((dataset) => dataset.name).sort();
    }
    expect(await names('')).toEqual(['Active', 'Old']);
    expect(await names('?archived=false')).toEqual([active.dataset.name]);
    expect(await names('?archived=true')).toEqual([old.dataset.name]);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/datasets?archived=yes`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(422);
  });

  it('archive済みDatasetの版を使うJobのretryは新しいRunを作るので422', async () => {
    const fixture = await executionFixture(harness);
    const { dataset, version } = await datasetWithVersion(fixture);
    const run = await entity<Run>(await runWithInputs(fixture, [version.id]));
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    await harness.database.query("UPDATE jobs SET status='failed' WHERE id=$1", [job.id]);
    await harness.database.query("UPDATE runs SET status='failed' WHERE id=$1", [run.id]);
    await entity(
      await patch(`${fixture.basePath}/datasets/${dataset.id}`, {
        cookie: fixture.editor.cookie,
        body: { archived: true },
      }),
      200,
    );
    const retry = await request(harness.app, `${fixture.basePath}/jobs/${job.id}/retry`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
    });
    expect(retry.status).toBe(422);
    expect(await retry.json()).toMatchObject({ code: 'dataset_archived' });
  });

  it('他ProjectのModel・版・Experiment・DatasetのIDは404', async () => {
    const fixture = await executionFixture(harness);
    const other = await otherProject(fixture);
    const { cookie } = fixture.editor;
    const reads = [
      `${fixture.basePath}/models/${other.model.id}`,
      `${fixture.basePath}/models/${other.model.id}/versions/${other.version.id}`,
      // A version of another Model in the same Project is not found under this Model either.
      `${fixture.basePath}/models/${fixture.model.id}/versions/${other.version.id}`,
      `${fixture.basePath}/experiments/${other.experiment.id}`,
      `${fixture.basePath}/datasets/${other.dataset.id}`,
    ];
    for (const endpoint of reads)
      expect((await request(harness.app, endpoint, { cookie })).status).toBe(404);
    const writes = [
      [`${fixture.basePath}/models/${other.model.id}`, { description: 'x' }],
      [`${fixture.basePath}/experiments/${other.experiment.id}`, { name: 'x' }],
      [`${fixture.basePath}/datasets/${other.dataset.id}`, { archived: true }],
    ] as const;
    for (const [endpoint, body] of writes)
      expect((await patch(endpoint, { cookie, body })).status).toBe(404);
    const untouched = await harness.database.query(
      'SELECT archived_at FROM datasets WHERE id=$1',
      [other.dataset.id],
    );
    expect(untouched.rows[0]).toEqual({ archived_at: null });
  });

  it('同じProjectでも別Modelの版はネストした取得で404', async () => {
    const fixture = await executionFixture(harness);
    const sibling = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Sibling', family: 'qwen2' },
      }),
    );
    const response = await request(
      harness.app,
      `${fixture.basePath}/models/${sibling.id}/versions/${fixture.modelVersion.id}`,
      { cookie: fixture.viewer.cookie },
    );
    expect(response.status).toBe(404);
  });
});
