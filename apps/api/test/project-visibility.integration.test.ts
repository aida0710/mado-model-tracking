import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Project, ProjectMember, ServiceAccount } from '@mmt/contracts';
import { migrate } from '../src/db/migrate.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { applyMigrationsBefore } from './migrationFixtures.js';

type Identity = { cookie: string; userId: string };

describe.skipIf(!testDatabaseUrl)('Projectの公開範囲（独立PostgreSQL）', () => {
  let harness: Harness;
  let owner: Identity;
  let someone: Identity;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    owner = await login(harness, 'owner@localhost');
    someone = await login(harness, 'someone@localhost');
  });
  afterAll(async () => {
    await harness?.close();
  });

  function postProject(cookie: string, body: Record<string, unknown>): Promise<Response> {
    return request(harness.app, '/api/projects', {
      method: 'POST',
      cookie,
      body,
    });
  }

  async function createProject(cookie: string, body: Record<string, unknown>): Promise<Project> {
    return entity<Project>(await postProject(cookie, body));
  }

  async function visibleProjects(cookie: string): Promise<Project[]> {
    return (
      await entity<{ items: Project[] }>(
        await request(harness.app, '/api/projects', { cookie }),
        200,
      )
    ).items;
  }

  async function members(projectId: string, cookie: string): Promise<ProjectMember[]> {
    return (
      await entity<{ items: ProjectMember[] }>(
        await request(harness.app, `/api/projects/${projectId}/members`, {
          cookie,
        }),
        200,
      )
    ).items;
  }

  function createExperiment(projectId: string, cookie: string, name: string): Promise<Response> {
    return request(harness.app, `/api/projects/${projectId}/experiments`, {
      method: 'POST',
      cookie,
      body: { name },
    });
  }

  function grant(projectId: string, member: { userId: string; role: string }): Promise<Response> {
    return request(harness.app, `/api/projects/${projectId}/members/${member.userId}`, {
      method: 'PUT',
      cookie: owner.cookie,
      body: { role: member.role },
    });
  }

  async function effectiveRole(projectId: string, userId: string) {
    const found = await harness.database.query(
      'SELECT role,sources FROM effective_project_roles WHERE project_id=$1 AND user_id=$2',
      [projectId, userId],
    );
    return found.rows[0] ?? null;
  }

  it('publicのProjectは有効な人の利用者全員がメンバーでなくてもeditorとして使え、管理はできない', async () => {
    const project = await createProject(owner.cookie, { name: 'Shared' });
    expect(project).toMatchObject({ visibility: 'public', role: 'admin' });

    expect(await visibleProjects(someone.cookie)).toEqual([
      expect.objectContaining({
        id: project.id,
        visibility: 'public',
        role: 'editor',
      }),
    ]);
    expect((await createExperiment(project.id, someone.cookie, 'by someone')).status).toBe(201);
    for (const response of [
      await request(harness.app, `/api/projects/${project.id}`, {
        method: 'PATCH',
        cookie: someone.cookie,
        body: { description: 'changed' },
      }),
      await request(harness.app, `/api/projects/${project.id}/archive`, {
        method: 'POST',
        cookie: someone.cookie,
      }),
      await request(harness.app, `/api/projects/${project.id}/members/${someone.userId}`, {
        method: 'PUT',
        cookie: someone.cookie,
        body: { role: 'admin' },
      }),
    ]) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe('project_forbidden');
    }
  });

  it('privateのProjectはメンバーだけが使え、メンバーでない人の一覧にも出ない', async () => {
    const project = await createProject(owner.cookie, {
      name: 'Closed',
      visibility: 'private',
    });
    expect(project.visibility).toBe('private');
    expect(await visibleProjects(someone.cookie)).toEqual([]);
    expect(
      (
        await request(harness.app, `/api/projects/${project.id}/experiments`, {
          cookie: someone.cookie,
        })
      ).status,
    ).toBe(403);
    expect((await createExperiment(project.id, someone.cookie, 'refused')).status).toBe(403);

    expect((await grant(project.id, { userId: someone.userId, role: 'viewer' })).status).toBe(200);
    expect(await visibleProjects(someone.cookie)).toEqual([
      expect.objectContaining({ id: project.id, role: 'viewer' }),
    ]);
    expect((await createExperiment(project.id, someone.cookie, 'still refused')).status).toBe(403);
  });

  it('Project adminが公開範囲を変えると次の要求から効き、省略した項目は今の値のまま', async () => {
    const project = await createProject(owner.cookie, {
      name: 'Switch',
      description: 'keep me',
    });
    const patch = (body: Record<string, unknown>) =>
      request(harness.app, `/api/projects/${project.id}`, {
        method: 'PATCH',
        cookie: owner.cookie,
        body,
      });
    expect(await entity<Project>(await patch({ visibility: 'private' }), 200)).toMatchObject({
      visibility: 'private',
      description: 'keep me',
      role: 'admin',
    });
    expect((await createExperiment(project.id, someone.cookie, 'after private')).status).toBe(403);
    expect(await entity<Project>(await patch({ visibility: 'public' }), 200)).toMatchObject({
      visibility: 'public',
      description: 'keep me',
    });
    expect((await createExperiment(project.id, someone.cookie, 'after public')).status).toBe(201);
    const audit = await harness.database.query(
      "SELECT details FROM audit_events WHERE project_id=$1 AND action='project.update' ORDER BY occurred_at,id",
      [project.id],
    );
    expect(audit.rows.map((row) => row.details)).toEqual([
      { fields: ['visibility'], visibility: 'private' },
      { fields: ['visibility'], visibility: 'public' },
    ]);
  });

  it('publicの権限はService Account・launcher・無効化した利用者には付かない', async () => {
    const project = await createProject(owner.cookie, {
      name: 'Open to people',
    });
    const serviceAccount = await entity<ServiceAccount>(
      await request(harness.app, `/api/projects/${project.id}/service-accounts`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { name: 'reader', role: 'viewer' },
      }),
    );
    const anotherPublic = await createProject(owner.cookie, {
      name: 'Another public',
    });
    const launcher = await harness.database.query<{ id: string }>(
      "INSERT INTO users(issuer,subject,email,display_name,kind) VALUES('launcher','l1','l1@launcher','Launcher','launcher') RETURNING id",
    );
    const leaver = await login(harness, 'leaver@localhost');
    await harness.database.query("UPDATE users SET status='disabled' WHERE id=$1", [leaver.userId]);

    // The Service Account keeps exactly the role set on it, and gets nothing elsewhere.
    expect(await effectiveRole(project.id, serviceAccount.id)).toEqual({
      role: 'viewer',
      sources: ['direct'],
    });
    expect(await effectiveRole(anotherPublic.id, serviceAccount.id)).toBeNull();
    expect(await effectiveRole(project.id, launcher.rows[0]!.id)).toBeNull();
    expect(await effectiveRole(project.id, leaver.userId)).toBeNull();
    expect(await effectiveRole(project.id, someone.userId)).toEqual({
      role: 'editor',
      sources: ['public'],
    });
  });

  it('メンバー一覧はpublicだけで使っている人を出さず、roleは直接付与とgroupだけで決める', async () => {
    const project = await createProject(owner.cookie, { name: 'Members' });
    const reader = await login(harness, 'reader@localhost');
    expect((await grant(project.id, { userId: reader.userId, role: 'viewer' })).status).toBe(200);

    const listed = await members(project.id, someone.cookie);
    expect(
      listed.map(({ user, role, directRole }) => ({
        id: user.id,
        role,
        directRole,
      })),
    ).toEqual(
      expect.arrayContaining([
        { id: owner.userId, role: 'admin', directRole: 'admin' },
        { id: reader.userId, role: 'viewer', directRole: 'viewer' },
      ]),
    );
    expect(listed).toHaveLength(2);
    // Their effective role is still the stronger public editor.
    expect(await visibleProjects(reader.cookie)).toEqual([
      expect.objectContaining({ id: project.id, role: 'editor' }),
    ]);
  });

  it('全体管理者のsessionはpublicでeditorになるProjectでもadminとして扱う', async () => {
    const administrator = await login(harness);
    const project = await createProject(owner.cookie, { name: 'Administered' });
    expect(await visibleProjects(administrator.cookie)).toEqual([
      expect.objectContaining({ id: project.id, role: 'admin' }),
    ]);
    const patched = await request(harness.app, `/api/projects/${project.id}`, {
      method: 'PATCH',
      cookie: administrator.cookie,
      body: { description: 'by the administrator' },
    });
    expect(patched.status).toBe(200);
  });

  it('作成時に指定したメンバーを同じtransactionで追加し、それぞれproject.member.setとして監査に残す', async () => {
    const alice = await login(harness, 'alice@localhost');
    const bob = await login(harness, 'bob@localhost');
    const project = await createProject(owner.cookie, {
      name: 'With members',
      visibility: 'private',
      members: [
        { userId: alice.userId, role: 'editor' },
        { userId: bob.userId, role: 'viewer' },
        // The creator is always admin; this grant is ignored.
        { userId: owner.userId, role: 'viewer' },
      ],
    });
    const listed = await members(project.id, owner.cookie);
    expect(Object.fromEntries(listed.map(({ user, role }) => [user.id, role]))).toEqual({
      [owner.userId]: 'admin',
      [alice.userId]: 'editor',
      [bob.userId]: 'viewer',
    });

    const audit = await harness.database.query(
      'SELECT action,resource_id,details FROM audit_events WHERE project_id=$1 ORDER BY occurred_at,id',
      [project.id],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        {
          action: 'project.create',
          resource_id: project.id,
          details: {
            name: 'With members',
            visibility: 'private',
            artifactBackend: 'filesystem',
            memberCount: 2,
          },
        },
        {
          action: 'project.member.set',
          resource_id: alice.userId,
          details: { userId: alice.userId, previousRole: null, role: 'editor' },
        },
        {
          action: 'project.member.set',
          resource_id: bob.userId,
          details: { userId: bob.userId, previousRole: null, role: 'viewer' },
        },
      ]),
    );
    expect(audit.rows).toHaveLength(3);
  });

  it('作成時のメンバーに重複・存在しない・人でない・無効の利用者があれば、Projectを作らずに拒否する', async () => {
    const alice = await login(harness, 'alice@localhost');
    const leaver = await login(harness, 'leaver@localhost');
    await harness.database.query("UPDATE users SET status='disabled' WHERE id=$1", [leaver.userId]);
    const launcher = await harness.database.query<{ id: string }>(
      "INSERT INTO users(issuer,subject,email,display_name,kind) VALUES('launcher','l2','l2@launcher','Launcher','launcher') RETURNING id",
    );
    const cases: {
      members: { userId: string; role: string }[];
      status: number;
      code: string;
    }[] = [
      {
        members: [
          { userId: alice.userId, role: 'editor' },
          { userId: alice.userId, role: 'viewer' },
        ],
        status: 400,
        code: 'duplicate_project_member',
      },
      {
        members: [{ userId: '00000000-0000-4000-8000-000000000000', role: 'editor' }],
        status: 404,
        code: 'not_found',
      },
      {
        members: [{ userId: launcher.rows[0]!.id, role: 'viewer' }],
        status: 400,
        code: 'invalid_project_member',
      },
      {
        members: [
          { userId: alice.userId, role: 'editor' },
          { userId: leaver.userId, role: 'viewer' },
        ],
        status: 400,
        code: 'invalid_project_member',
      },
      {
        members: Array.from({ length: 101 }, (_, index) => ({
          userId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          role: 'viewer',
        })),
        status: 422,
        code: 'invalid_request',
      },
    ];
    for (const refused of cases) {
      const response = await postProject(owner.cookie, {
        name: 'Refused',
        members: refused.members,
      });
      expect(response.status).toBe(refused.status);
      expect(((await response.json()) as { code: string }).code).toBe(refused.code);
    }
    const created = await harness.database.query(
      "SELECT count(*)::int AS count FROM projects WHERE name='Refused'",
    );
    expect(created.rows[0]).toEqual({ count: 0 });
    const memberships = await harness.database.query(
      'SELECT count(*)::int AS count FROM project_members',
    );
    expect(memberships.rows[0]).toEqual({ count: 0 });
  });
});

describe.skipIf(!testDatabaseUrl)('公開範囲の移行（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({ applyMigrations: false });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('migration 054より前からあるProjectはprivateになり、それまでのアクセス範囲を変えない', async () => {
    await applyMigrationsBefore(harness.database, '054_project_visibility_and_archive.sql');
    const legacy = await harness.database.query<{
      project_id: string;
      member_id: string;
      other_id: string;
    }>(`
      WITH member AS (
        INSERT INTO users(issuer,subject,email,display_name) VALUES('fixture','member','member@localhost','Member') RETURNING id
      ), other AS (
        INSERT INTO users(issuer,subject,email,display_name) VALUES('fixture','other','other@localhost','Other') RETURNING id
      ), project AS (INSERT INTO projects(name) VALUES('Legacy') RETURNING id),
      membership AS (
        INSERT INTO project_members(project_id,user_id,role) SELECT project.id,member.id,'viewer' FROM project,member
      )
      SELECT project.id AS project_id,member.id AS member_id,other.id AS other_id FROM project,member,other`);
    const { project_id: projectId, member_id: memberId, other_id: otherId } = legacy.rows[0]!;

    await migrate(harness.database);

    const migrated = await harness.database.query(
      'SELECT visibility,archived_at FROM projects WHERE id=$1',
      [projectId],
    );
    expect(migrated.rows[0]).toEqual({
      visibility: 'private',
      archived_at: null,
    });
    const roles = await harness.database.query(
      'SELECT user_id,role FROM effective_project_roles WHERE project_id=$1',
      [projectId],
    );
    expect(roles.rows).toEqual([{ user_id: memberId, role: 'viewer' }]);
    expect(roles.rows.some((row) => row.user_id === otherId)).toBe(false);
    const created = await harness.database.query(
      "INSERT INTO projects(name) VALUES('After 054') RETURNING visibility",
    );
    expect(created.rows[0]).toEqual({ visibility: 'public' });
  });
});
