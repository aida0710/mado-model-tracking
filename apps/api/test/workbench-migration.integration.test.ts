import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createHarness, testDatabaseUrl, type Harness } from './harness.js';
import { applyMigrationsBefore } from './migrationFixtures.js';

describe.skipIf(!testDatabaseUrl)('既存Runの固定実行snapshot移行（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({ applyMigrations: false });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('007以前のPython/container/コードなしRunを008だけで移行し、再適用で不変にする', async () => {
    await applyMigrationsBefore(harness.database, '008_experiment_tasks.sql');
    const references = (
      await harness.database.query(`WITH legacy_user AS (
      INSERT INTO users(issuer,subject,email,display_name) VALUES('fixture','legacy','legacy@localhost','Legacy') RETURNING id
    ), legacy_project AS (INSERT INTO projects(name) VALUES('Legacy') RETURNING id),
    legacy_experiment AS (INSERT INTO experiments(project_id,name) SELECT id,'Legacy' FROM legacy_project RETURNING id,project_id),
    legacy_code AS (INSERT INTO codes(project_id,name) SELECT id,'Legacy' FROM legacy_project RETURNING id,project_id)
    SELECT u.id AS user_id,p.id AS project_id,e.id AS experiment_id,c.id AS code_id
    FROM legacy_user u,legacy_project p,legacy_experiment e,legacy_code c`)
    ).rows[0];
    const image = `example.test/image@sha256:${'a'.repeat(64)}`;
    for (const [kind, source, runtime] of [
      ['python', { kind: 'inline', files: { 'main.py': 'pass' } }, { kind: 'python' }],
      ['docker', null, { kind: 'docker', image }],
    ] as const) {
      const code = (
        await harness.database.query(
          `INSERT INTO code_versions(code_id,project_id,version,source,runtime,entrypoint,environment,supported_model_families,task_types)
        VALUES($1,$2,$3,$4,$5,'{python,main.py}','{"FIXTURE_SETTING":"value"}','{fixture}','{training}') RETURNING id`,
          [
            references.code_id,
            references.project_id,
            kind,
            source ? JSON.stringify(source) : null,
            JSON.stringify(runtime),
          ],
        )
      ).rows[0];
      await harness.database.query(
        `INSERT INTO runs(project_id,experiment_id,name,kind,status,code_version_id,created_by,environment)
        VALUES($1,$2,$3,'training','finished',$4,$5,$6)`,
        [
          references.project_id,
          references.experiment_id,
          kind,
          code.id,
          references.user_id,
          JSON.stringify({ runtime, preserved: kind }),
        ],
      );
    }
    await harness.database.query(
      `INSERT INTO runs(project_id,experiment_id,name,kind,created_by)
      VALUES($1,$2,'no-code','training',$3)`,
      [references.project_id, references.experiment_id, references.user_id],
    );
    await migrate(harness.database);
    const before = (
      await harness.database.query(
        'SELECT id,name,execution_mode,execution_snapshot,environment,task_id,task_revision FROM runs ORDER BY name',
      )
    ).rows;
    expect(before).toHaveLength(3);
    for (const run of before) {
      expect(run).toMatchObject({ execution_mode: 'run', task_id: null, task_revision: null });
      if (run.name === 'no-code') expect(run.execution_snapshot).toBeNull();
      else
        expect(run.execution_snapshot).toMatchObject({
          codeVersionId: expect.any(String),
          version: run.name,
          mode: 'run',
          source: run.name === 'docker' ? null : { kind: 'inline', files: { 'main.py': 'pass' } },
          runtime: run.name === 'docker' ? { kind: 'docker', image } : { kind: 'python' },
          entrypoint: ['python', 'main.py'],
          requirements: [],
          environment: { FIXTURE_SETTING: 'value' },
        });
    }
    expect(
      (await harness.database.query('SELECT test_entrypoint FROM code_versions')).rows.every(
        (code) => code.test_entrypoint.length === 0,
      ),
    ).toBe(true);
    await migrate(harness.database);
    expect(
      (
        await harness.database.query(
          'SELECT id,name,execution_mode,execution_snapshot,environment,task_id,task_revision FROM runs ORDER BY name',
        )
      ).rows,
    ).toEqual(before);
    await expect(
      harness.database.query("UPDATE runs SET execution_snapshot='{}' WHERE name='python'"),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
