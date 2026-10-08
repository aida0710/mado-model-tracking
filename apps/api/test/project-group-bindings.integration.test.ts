import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Job,
  Model,
  Project,
  ProjectGroupBinding,
  ProjectMember,
  ProjectRole,
  Run,
  UserSearchResult,
  WorkerJob,
} from '@mmt/contracts';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture, projectFixture } from './fixtures.js';

type Fixture = Awaited<ReturnType<typeof projectFixture>>;
type Identity = { cookie: string; userId: string };

const ML_TEAM = 'ml-team';
const NOW = '2026-10-08T00:00:00.000Z';

describe.skipIf(!testDatabaseUrl)('SSO groupのProject権限（独立PostgreSQL）', () => {
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

  // Stands in for the SSO login sync, which writes user_groups (auth-oidc-group-policy).
  async function joinGroup(userId: string, group = ML_TEAM): Promise<void> {
    await harness.database.query(
      'INSERT INTO user_groups(user_id,group_name) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [userId, group],
    );
  }

  async function leaveGroup(userId: string, group = ML_TEAM): Promise<void> {
    await harness.database.query('DELETE FROM user_groups WHERE user_id=$1 AND group_name=$2', [
      userId,
      group,
    ]);
  }

  function putBinding(
    fixture: Fixture,
    binding: { group?: string; role: ProjectRole; cookie?: string; token?: string },
  ): Promise<Response> {
    const credentials = binding.token
      ? { token: binding.token }
      : { cookie: binding.cookie ?? fixture.administrator.cookie };
    return request(
      harness.app,
      `${fixture.basePath}/group-bindings/${encodeURIComponent(binding.group ?? ML_TEAM)}`,
      { method: 'PUT', ...credentials, body: { role: binding.role } },
    );
  }

  async function bindGroup(fixture: Fixture, role: ProjectRole, group = ML_TEAM) {
    return entity<ProjectGroupBinding>(await putBinding(fixture, { group, role }), 200);
  }

  function deleteBinding(fixture: Fixture, group = ML_TEAM, cookie?: string): Promise<Response> {
    return request(harness.app, `${fixture.basePath}/group-bindings/${encodeURIComponent(group)}`, {
      method: 'DELETE',
      cookie: cookie ?? fixture.administrator.cookie,
    });
  }

  function deleteMember(fixture: Fixture, userId: string, cookie?: string): Promise<Response> {
    return request(harness.app, `${fixture.basePath}/members/${userId}`, {
      method: 'DELETE',
      cookie: cookie ?? fixture.administrator.cookie,
    });
  }

  function createRun(fixture: Fixture, credentials: { cookie?: string; token?: string }) {
    return request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      ...credentials,
      body: { experimentId: fixture.experiment.id, name: 'Group run', kind: 'training' },
    });
  }

  async function members(fixture: Fixture): Promise<ProjectMember[]> {
    return (
      await entity<{ items: ProjectMember[] }>(
        await request(harness.app, `${fixture.basePath}/members`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      )
    ).items;
  }

  async function projectToken(
    identity: Identity,
    project: { projectId: string; scopes: string[] },
  ): Promise<string> {
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: identity.cookie,
        body: { name: 'Project token', kind: 'personal', ...project },
      }),
    );
    return minted.token;
  }

  async function auditActions(projectId: string): Promise<{ action: string; outcome: string }[]> {
    const audit = await harness.database.query(
      "SELECT action,outcome FROM audit_events WHERE project_id=$1 AND action LIKE 'project.%' ORDER BY occurred_at,id",
      [projectId],
    );
    return audit.rows;
  }

  it('editorのgroup bindingだけでRun作成とModel登録ができ、メンバー一覧にgroup経由で出る', async () => {
    const fixture = await projectFixture(harness);
    const member = await login(harness, 'ml@localhost');
    await joinGroup(member.userId);
    expect((await createRun(fixture, { cookie: member.cookie })).status).toBe(403);

    const binding = await bindGroup(fixture, 'editor');
    expect(binding).toMatchObject({
      projectId: fixture.project.id,
      group: ML_TEAM,
      role: 'editor',
      createdBy: fixture.administrator.userId,
    });
    expect((await createRun(fixture, { cookie: member.cookie })).status).toBe(201);
    const model = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: member.cookie,
        body: { name: 'Group model', family: 'qwen2' },
      }),
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
          method: 'POST',
          cookie: member.cookie,
          body: {},
        })
      ).status,
    ).toBe(201);

    const projects = await entity<{ items: Project[] }>(
      await request(harness.app, '/api/projects', { cookie: member.cookie }),
      200,
    );
    expect(projects.items.map((project) => [project.id, project.role])).toEqual([
      [fixture.project.id, 'editor'],
    ]);
    const listed = (await members(fixture)).find((entry) => entry.user.id === member.userId);
    expect(listed).toMatchObject({
      role: 'editor',
      directRole: null,
      groups: [{ group: ML_TEAM, role: 'editor' }],
    });
    const bindings = await entity<{ items: ProjectGroupBinding[] }>(
      await request(harness.app, `${fixture.basePath}/group-bindings`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(bindings.items.map((item) => [item.group, item.role])).toEqual([[ML_TEAM, 'editor']]);
  });

  it('viewerのgroup bindingでは読めるがRun作成は403', async () => {
    const fixture = await projectFixture(harness);
    const member = await login(harness, 'ml@localhost');
    await joinGroup(member.userId);
    await bindGroup(fixture, 'viewer');
    expect(
      (await request(harness.app, `${fixture.basePath}/runs`, { cookie: member.cookie })).status,
    ).toBe(200);
    expect((await createRun(fixture, { cookie: member.cookie })).status).toBe(403);
  });

  it('直接viewerとgroup editorの実効roleはeditorで、直接付与を外してもgroup分が残る', async () => {
    const fixture = await projectFixture(harness);
    await joinGroup(fixture.viewer.userId);
    await bindGroup(fixture, 'editor');
    const listed = (await members(fixture)).find((entry) => entry.user.id === fixture.viewer.userId);
    expect(listed).toMatchObject({
      role: 'editor',
      directRole: 'viewer',
      groups: [{ group: ML_TEAM, role: 'editor' }],
    });
    expect((await createRun(fixture, { cookie: fixture.viewer.cookie })).status).toBe(201);

    expect((await deleteMember(fixture, fixture.viewer.userId)).status).toBe(204);
    expect(
      (await members(fixture)).find((entry) => entry.user.id === fixture.viewer.userId),
    ).toMatchObject({ role: 'editor', directRole: null });
    expect((await deleteMember(fixture, fixture.viewer.userId)).status).toBe(404);
  });

  it('user_groupsから外れると即403になり、group由来だけのProject tokenも401になる', async () => {
    const fixture = await projectFixture(harness);
    const member = await login(harness, 'ml@localhost');
    await joinGroup(member.userId);
    await bindGroup(fixture, 'editor');
    const token = await projectToken(member, {
      projectId: fixture.project.id,
      scopes: ['read', 'runs:write'],
    });
    expect((await createRun(fixture, { token })).status).toBe(201);

    await leaveGroup(member.userId);
    expect((await createRun(fixture, { cookie: member.cookie })).status).toBe(403);
    expect(
      (await request(harness.app, `${fixture.basePath}/runs`, { cookie: member.cookie })).status,
    ).toBe(403);
    expect((await request(harness.app, `${fixture.basePath}/runs`, { token })).status).toBe(401);

    // The token was not revoked: rejoining the group makes it usable again.
    await joinGroup(member.userId);
    expect((await request(harness.app, `${fixture.basePath}/runs`, { token })).status).toBe(200);
  });

  it('MLflow互換APIのruns/createとArtifactも同じ実効roleで判定する', async () => {
    const fixture = await projectFixture(harness);
    const member = await login(harness, 'ml@localhost');
    await joinGroup(member.userId);
    await bindGroup(fixture, 'editor');
    const token = await projectToken(member, {
      projectId: fixture.project.id,
      scopes: ['read', 'runs:write', 'artifacts:write'],
    });
    const mlflow = `/api/mlflow/projects/${fixture.project.id}/api/2.0`;
    const created = await request(harness.app, `${mlflow}/mlflow/runs/create`, {
      method: 'POST',
      token,
      body: { experiment_id: fixture.experiment.id },
    });
    expect(created.status).toBe(200);
    const runId = ((await created.json()) as { run: { info: { run_id: string } } }).run.info.run_id;
    const uploadArtifact = () =>
      request(
        harness.app,
        `${mlflow}/mlflow-artifacts/artifacts/runs/${runId}/artifacts/output/file.txt`,
        { method: 'PUT', token, binary: 'data', headers: { 'Content-Type': 'text/plain' } },
      );
    expect((await uploadArtifact()).status).toBe(200);

    await bindGroup(fixture, 'viewer');
    expect(
      (
        await request(harness.app, `${mlflow}/mlflow/runs/create`, {
          method: 'POST',
          token,
          body: { experiment_id: fixture.experiment.id },
        })
      ).status,
    ).toBe(403);
    expect((await uploadArtifact()).status).toBe(403);
    expect(
      (
        await request(
          harness.app,
          `${mlflow}/mlflow-artifacts/artifacts/runs/${runId}/artifacts/output/file.txt`,
          { token },
        )
      ).status,
    ).toBe(200);
  });

  it('Job tokenはRun作成者のgroup由来の実効roleで判定する', async () => {
    const fixture = await executionFixture(harness);
    const member = await login(harness, 'ml@localhost');
    await joinGroup(member.userId);
    await bindGroup(fixture, 'editor');
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: member.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Group job',
          kind: 'training',
          modelVersionId: fixture.modelVersion.id,
        },
      }),
    );
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: member.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const claimed = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'group-worker' },
      }),
      200,
    );
    const jobToken = claimed.item!.jobToken!;
    const logMetric = () =>
      request(harness.app, `${fixture.basePath}/runs/${run.id}/metrics`, {
        method: 'POST',
        token: jobToken,
        body: { metrics: [{ name: 'loss', value: 0.5, step: 1, timestamp: NOW }] },
      });
    expect((await logMetric()).status).toBe(204);
    await bindGroup(fixture, 'viewer');
    expect((await logMetric()).status).toBe(403);
    await leaveGroup(member.userId);
    expect(
      (await request(harness.app, `${fixture.basePath}/runs/${run.id}`, { token: jobToken }))
        .status,
    ).toBe(403);
  });

  it('最後の直接adminは外せないが、adminのgroup bindingがあれば外せる', async () => {
    const fixture = await projectFixture(harness);
    const administratorId = fixture.administrator.userId;
    expect((await deleteMember(fixture, administratorId)).status).toBe(409);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/members/${administratorId}`, {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { role: 'editor' },
        })
      ).status,
    ).toBe(409);

    await bindGroup(fixture, 'admin');
    expect((await deleteMember(fixture, administratorId)).status).toBe(204);
    expect((await members(fixture)).some((entry) => entry.user.id === administratorId)).toBe(
      false,
    );
  });

  it('管理者が0になるadmin bindingの削除・格下げは409', async () => {
    const fixture = await projectFixture(harness);
    const groupAdmin = await login(harness, 'lead@localhost');
    await joinGroup(groupAdmin.userId);
    await bindGroup(fixture, 'admin');
    expect((await deleteMember(fixture, fixture.administrator.userId)).status).toBe(204);

    expect((await deleteBinding(fixture, ML_TEAM, groupAdmin.cookie)).status).toBe(409);
    expect((await putBinding(fixture, { role: 'editor', cookie: groupAdmin.cookie })).status).toBe(
      409,
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/members/${groupAdmin.userId}`, {
          method: 'PUT',
          cookie: groupAdmin.cookie,
          body: { role: 'admin' },
        })
      ).status,
    ).toBe(200);
    expect((await deleteBinding(fixture, ML_TEAM, groupAdmin.cookie)).status).toBe(204);
    expect((await deleteBinding(fixture, ML_TEAM, groupAdmin.cookie)).status).toBe(404);
  });

  it('2人の直接adminを並行して外すと片方だけ成功する', async () => {
    const fixture = await projectFixture(harness);
    const second = await login(harness, 'second-admin@localhost');
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${second.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'admin' },
      }),
      200,
    );
    // The global administrator keeps session access after losing the direct grant.
    const statuses = await Promise.all([
      deleteMember(fixture, fixture.administrator.userId),
      deleteMember(fixture, second.userId),
    ]).then((responses) => responses.map((response) => response.status).sort());
    expect(statuses).toEqual([204, 409]);
    const remaining = await harness.database.query(
      "SELECT count(*)::int AS count FROM project_members WHERE project_id=$1 AND role='admin'",
      [fixture.project.id],
    );
    expect(remaining.rows[0].count).toBe(1);
  });

  it('Project限定tokenからのbinding変更にはadmin scopeが要る', async () => {
    const fixture = await projectFixture(harness);
    const writeToken = await projectToken(fixture.administrator, {
      projectId: fixture.project.id,
      scopes: ['read', 'runs:write'],
    });
    const response = await putBinding(fixture, { role: 'viewer', token: writeToken });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('insufficient_scope');

    const adminToken = await projectToken(fixture.administrator, {
      projectId: fixture.project.id,
      scopes: ['admin'],
    });
    expect((await putBinding(fixture, { role: 'viewer', token: adminToken })).status).toBe(200);
    const editorToken = await projectToken(fixture.editor, {
      projectId: fixture.project.id,
      scopes: ['read'],
    });
    expect((await putBinding(fixture, { role: 'admin', token: editorToken })).status).toBe(403);
  });

  it('group名は空白や/を含んでもそのまま扱い、制御文字は422', async () => {
    const fixture = await projectFixture(harness);
    const group = 'Research Team/音声';
    expect((await bindGroup(fixture, 'viewer', group)).group).toBe(group);
    expect((await putBinding(fixture, { group: 'bad\u0001group', role: 'viewer' })).status).toBe(
      422,
    );
    expect((await deleteBinding(fixture, group)).status).toBe(204);
  });

  it('users検索はProject管理者と全体管理者だけが使え、email・表示名だけを前方一致で返す', async () => {
    const fixture = await projectFixture(harness);
    const search = (query: string, cookie: string) =>
      request(harness.app, `/api/users?${new URLSearchParams({ query })}`, { cookie });
    expect((await search('ed', fixture.viewer.cookie)).status).toBe(403);
    expect((await search('ed', fixture.editor.cookie)).status).toBe(403);

    const found = await entity<{ items: UserSearchResult[] }>(
      await search('EDITOR', fixture.administrator.cookie),
      200,
    );
    expect(found.items).toEqual([
      { id: fixture.editor.userId, email: 'editor@localhost', displayName: expect.any(String) },
    ]);
    expect(
      (await entity<{ items: UserSearchResult[] }>(await search('%', fixture.administrator.cookie), 200))
        .items,
    ).toEqual([]);
    expect((await search('', fixture.administrator.cookie)).status).toBe(422);

    for (let index = 0; index < 25; index += 1) await login(harness, `bulk${index}@localhost`);
    expect(
      (await entity<{ items: UserSearchResult[] }>(await search('bulk', fixture.administrator.cookie), 200))
        .items,
    ).toHaveLength(20);

    // A Project admin who is not a global administrator, holding the role through a group.
    const lead = await login(harness, 'lead@localhost');
    await joinGroup(lead.userId);
    await bindGroup(fixture, 'admin');
    expect((await search('viewer', lead.cookie)).status).toBe(200);
    const groups = await entity<{ items: string[] }>(
      await request(harness.app, '/api/auth/groups', { cookie: lead.cookie }),
      200,
    );
    expect(groups.items).toEqual([ML_TEAM]);
    expect(
      (await request(harness.app, '/api/auth/groups', { cookie: fixture.viewer.cookie })).status,
    ).toBe(403);
  });

  it('binding・メンバー削除の成功と拒否がaudit_eventsに残る', async () => {
    const fixture = await projectFixture(harness);
    await bindGroup(fixture, 'editor');
    await bindGroup(fixture, 'viewer');
    expect((await deleteBinding(fixture, ML_TEAM, fixture.editor.cookie)).status).toBe(403);
    expect((await deleteBinding(fixture)).status).toBe(204);
    expect((await deleteMember(fixture, fixture.viewer.userId)).status).toBe(204);
    expect((await deleteMember(fixture, fixture.administrator.userId)).status).toBe(409);

    const actions = (await auditActions(fixture.project.id)).filter(
      (event) => !(event.action === 'project.member.set' && event.outcome === 'success'),
    );
    expect(actions).toEqual([
      { action: 'project.group_binding.set', outcome: 'success' },
      { action: 'project.group_binding.set', outcome: 'success' },
      { action: 'project.group_binding.delete', outcome: 'denied' },
      { action: 'project.group_binding.delete', outcome: 'success' },
      { action: 'project.member.delete', outcome: 'success' },
      { action: 'project.member.delete', outcome: 'denied' },
    ]);
    const changed = await harness.database.query(
      "SELECT details FROM audit_events WHERE project_id=$1 AND action='project.group_binding.set' ORDER BY occurred_at,id",
      [fixture.project.id],
    );
    expect(changed.rows.map((row) => row.details)).toEqual([
      { group: ML_TEAM, previousRole: null, role: 'editor' },
      { group: ML_TEAM, previousRole: 'editor', role: 'viewer' },
    ]);
  });
});
