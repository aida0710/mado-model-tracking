import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { transaction } from '../src/db/database.js';
import { createHarness, testDatabaseUrl, type Harness } from './harness.js';
import { applyMigrationsBefore } from './migrationFixtures.js';

describe.skipIf(!testDatabaseUrl)('既存Registryとtargetのruntime移行（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({ applyMigrations: false });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('既存コード・target・RunをPythonへ移行し、過去モデルは処理済みにし、SSOユーザーの識別子を引き継ぐ', async () => {
    await applyMigrationsBefore(harness.database, '003_execution_runtime.sql');
    const registered = await harness.database.query(`
      WITH legacy_user AS (
        INSERT INTO users(issuer,subject,email,display_name,is_admin) VALUES('fixture','legacy','legacy@localhost','Legacy',true) RETURNING id
      ), legacy_project AS (
        INSERT INTO projects(name) VALUES('Legacy Project') RETURNING id
      ), legacy_experiment AS (
        INSERT INTO experiments(project_id,name) SELECT id,'Legacy experiment' FROM legacy_project RETURNING id,project_id
      ), legacy_code AS (
        INSERT INTO codes(project_id,name) SELECT id,'Legacy code' FROM legacy_project RETURNING id,project_id
      ), legacy_code_version AS (
        INSERT INTO code_versions(code_id,project_id,version,source,entrypoint,supported_model_families,task_types)
        SELECT id,project_id,'v1','{"kind":"inline","files":{"main.py":"pass"}}','{python,main.py}','{fixture}','{inference}' FROM legacy_code RETURNING id,project_id
      ), legacy_model AS (
        INSERT INTO models(project_id,name,family) SELECT id,'Legacy model','fixture' FROM legacy_project RETURNING id,project_id
      ), legacy_model_version AS (
        INSERT INTO model_versions(model_id,project_id,version,weights_uri) SELECT id,project_id,'v1','file:///fixture/weights' FROM legacy_model RETURNING id,project_id
      ), legacy_run AS (
        INSERT INTO runs(project_id,experiment_id,name,kind,code_version_id,model_version_id,created_by,environment)
        SELECT p.id,e.id,'Legacy run','inference',c.id,m.id,u.id,'{"host":"fixture"}'
        FROM legacy_project p,legacy_experiment e,legacy_code_version c,legacy_model_version m,legacy_user u RETURNING id
      ), legacy_target AS (
        INSERT INTO compute_targets(name,host,port,username,ssh_key_path,known_hosts_path,work_directory,python_executable,max_concurrent_jobs,executor)
        VALUES('Legacy target','127.0.0.1',22,'fixture','','','/tmp/fixture','python3',1,'local') RETURNING id
      ), development_user AS (
        INSERT INTO users(issuer,subject,email,display_name) VALUES('development','dev@localhost','dev@localhost','Dev') RETURNING id
      ) SELECT p.id AS project_id,c.id AS code_version_id,m.id AS model_version_id,r.id AS run_id,t.id AS target_id,
        u.id AS user_id,d.id AS development_user_id
      FROM legacy_project p,legacy_code_version c,legacy_model_version m,legacy_run r,legacy_target t,legacy_user u,development_user d`);
    await harness.database.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('legacy-session',$1,now()+interval '1 hour'),('development-session',$2,now()+interval '1 hour')",
      [registered.rows[0].user_id, registered.rows[0].development_user_id],
    );
    const legacy = registered.rows[0];
    await migrate(harness.database);
    await migrate(harness.database);
    // SSO users keep their user.id through user_oidc_identities; development users are not SSO identities.
    expect(
      (
        await harness.database.query(
          'SELECT issuer,subject,user_id,email_at_login,email_verified FROM user_oidc_identities',
        )
      ).rows,
    ).toEqual([
      {
        issuer: 'fixture',
        subject: 'legacy',
        user_id: legacy.user_id,
        email_at_login: 'legacy@localhost',
        email_verified: true,
      },
    ]);
    expect(
      (
        await harness.database.query('SELECT status,username FROM users WHERE id=$1', [
          legacy.user_id,
        ])
      ).rows,
    ).toEqual([{ status: 'active', username: null }]);
    expect(
      (
        await harness.database.query(
          'SELECT token_hash,auth_method FROM sessions ORDER BY token_hash',
        )
      ).rows,
    ).toEqual([
      { token_hash: 'development-session', auth_method: 'development' },
      { token_hash: 'legacy-session', auth_method: 'oidc' },
    ]);
    const code = (
      await harness.database.query('SELECT source,runtime FROM code_versions WHERE id=$1', [
        legacy.code_version_id,
      ])
    ).rows[0];
    expect(code.runtime).toEqual({ kind: 'python' });
    expect(code.source).toEqual({
      kind: 'inline',
      files: { 'main.py': 'pass' },
    });
    expect(
      (
        await harness.database.query('SELECT runtime_kinds FROM compute_targets WHERE id=$1', [
          legacy.target_id,
        ])
      ).rows[0].runtime_kinds,
    ).toEqual(['python']);
    expect(
      (await harness.database.query('SELECT environment FROM runs WHERE id=$1', [legacy.run_id]))
        .rows[0].environment,
    ).toEqual({ host: 'fixture', runtime: { kind: 'python' } });
    expect(
      (
        await harness.database.query(
          'SELECT * FROM model_automation_events WHERE model_version_id=$1',
          [legacy.model_version_id],
        )
      ).rows,
    ).toHaveLength(1);
    await transaction(harness.database, (connection) =>
      harness.services.automation.processRegistration(connection, {
        projectId: legacy.project_id,
        modelVersionId: legacy.model_version_id,
      }),
    );
    expect(
      (await harness.database.query('SELECT * FROM model_automation_executions')).rows,
    ).toHaveLength(0);
    await expect(
      harness.database.query('UPDATE code_versions SET version=$2 WHERE id=$1', [
        legacy.code_version_id,
        'changed',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
