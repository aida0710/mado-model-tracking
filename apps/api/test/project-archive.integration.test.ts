import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdminProject, Job, Project } from '@mmt/contracts';
import { transaction } from '../src/db/database.js';
import { hasAutomationOwnerAccess } from '../src/repositories/modelAutomationRepository.js';
import { hasPromotionRunAsAccess } from '../src/repositories/promotionRepository.js';
import {
  hasSweepOwnerAccess,
  listSchedulableSweepIds,
} from '../src/repositories/sweepRepository.js';
import { executionFixture } from './fixtures.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { sweepFixture } from './sweepFixtures.js';

type Identity = { cookie: string; userId: string };

describe.skipIf(!testDatabaseUrl)('Projectのアーカイブと全体管理（独立PostgreSQL）', () => {
  let harness: Harness;
  let administrator: Identity;
  let owner: Identity;
  let member: Identity;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    administrator = await login(harness);
    owner = await login(harness, 'owner@localhost');
    member = await login(harness, 'member@localhost');
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function createProject(body: Record<string, unknown> = {}): Promise<Project> {
    const project = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: owner.cookie,
        body: { name: 'Archived later', visibility: 'private', ...body },
      }),
    );
    await entity(
      await request(harness.app, `/api/projects/${project.id}/members/${member.userId}`, {
        method: 'PUT',
        cookie: owner.cookie,
        body: { role: 'editor' },
      }),
      200,
    );
    return project;
  }

  function archive(projectId: string, cookie = owner.cookie): Promise<Response> {
    return request(harness.app, `/api/projects/${projectId}/archive`, { method: 'POST', cookie });
  }

  function restore(projectId: string, cookie = administrator.cookie): Promise<Response> {
    return request(harness.app, `/api/admin/projects/${projectId}/restore`, {
      method: 'POST',
      cookie,
    });
  }

  async function adminProjects(query = ''): Promise<AdminProject[]> {
    return (
      await entity<{ items: AdminProject[] }>(
        await request(harness.app, `/api/admin/projects${query}`, { cookie: administrator.cookie }),
        200,
      )
    ).items;
  }

  function experiments(projectId: string, credentials: { cookie?: string; token?: string }) {
    return request(harness.app, `/api/projects/${projectId}/experiments`, credentials);
  }

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { code: string }).code;
  }

  async function auditActions(projectId: string) {
    const audit = await harness.database.query(
      "SELECT action,outcome FROM audit_events WHERE project_id=$1 AND action IN ('project.archive','project.restore','project.purge') ORDER BY occurred_at,id",
      [projectId],
    );
    return audit.rows;
  }

  it('アーカイブしたProjectは一覧から消えて全員に404になり、全体管理者が元に戻すと元どおり使える', async () => {
    const project = await createProject();
    const token = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: member.cookie,
        body: { name: 'Limited', kind: 'personal', projectId: project.id, scopes: ['read'] },
      }),
    );
    expect((await experiments(project.id, { token: token.token })).status).toBe(200);

    expect((await archive(project.id)).status).toBe(204);
    for (const identity of [owner, member, administrator]) {
      const listed = await entity<{ items: Project[] }>(
        await request(harness.app, '/api/projects', { cookie: identity.cookie }),
        200,
      );
      expect(listed.items.map((item) => item.id)).not.toContain(project.id);
      expect((await experiments(project.id, { cookie: identity.cookie })).status).toBe(404);
    }
    // A token limited to the Project no longer authenticates at all.
    expect((await experiments(project.id, { token: token.token })).status).toBe(401);
    expect(await adminProjects()).toEqual([]);
    expect(await adminProjects('?includeArchived=true')).toEqual([
      expect.objectContaining({ id: project.id, archivedAt: expect.any(String) }),
    ]);

    const restored = await entity<AdminProject>(await restore(project.id), 200);
    expect(restored).toMatchObject({ id: project.id, archivedAt: null, memberCount: 2 });
    expect((await experiments(project.id, { cookie: member.cookie })).status).toBe(200);
    expect((await experiments(project.id, { token: token.token })).status).toBe(200);
    // Restoring a live Project changes nothing and is not audited again.
    expect((await restore(project.id)).status).toBe(200);
    expect(await auditActions(project.id)).toEqual([
      { action: 'project.archive', outcome: 'success' },
      { action: 'project.restore', outcome: 'success' },
    ]);
  });

  it('待機中・実行中のJobがあるProjectはアーカイブできず、Jobが終われば通る', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun('Waiting job');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const refused = await archive(fixture.project.id, fixture.administrator.cookie);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe('project_has_active_jobs');
    expect((await experiments(fixture.project.id, { cookie: fixture.viewer.cookie })).status).toBe(
      200,
    );

    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    // A Job canceled while in a site's scheduler queue stays there until the launcher removes it,
    // which it does through the Job's row; until then the Project cannot be archived.
    const setSchedulerCancel = (state: 'pending' | 'done') =>
      harness.database.query('UPDATE jobs SET scheduler_cancel_state=$2 WHERE id=$1', [
        job.id,
        state,
      ]);
    await setSchedulerCancel('pending');
    const awaitingRemoval = await archive(fixture.project.id, fixture.administrator.cookie);
    expect(awaitingRemoval.status).toBe(409);
    expect(await errorCode(awaitingRemoval)).toBe('project_has_active_jobs');
    await setSchedulerCancel('done');
    expect((await archive(fixture.project.id, fixture.administrator.cookie)).status).toBe(204);
    expect(await auditActions(fixture.project.id)).toEqual([
      { action: 'project.archive', outcome: 'denied' },
      { action: 'project.archive', outcome: 'denied' },
      { action: 'project.archive', outcome: 'success' },
    ]);
  });

  it('権限の無い利用者はアーカイブ・元に戻す・完全な削除・管理一覧・ディレクトリ候補を使えない', async () => {
    const project = await createProject();
    const editorArchive = await archive(project.id, member.cookie);
    expect(editorArchive.status).toBe(403);
    expect(await errorCode(editorArchive)).toBe('project_forbidden');
    expect((await archive(project.id)).status).toBe(204);

    const adminToken = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: administrator.cookie,
        body: { name: 'Admin token', kind: 'personal', scopes: ['admin'] },
      }),
    );
    const readToken = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: administrator.cookie,
        body: { name: 'Read token', kind: 'personal', scopes: ['read'] },
      }),
    );
    const attempts = (credentials: { cookie?: string; token?: string }) => [
      request(harness.app, '/api/admin/projects?includeArchived=true', credentials),
      request(harness.app, `/api/admin/projects/${project.id}/restore`, {
        method: 'POST',
        ...credentials,
      }),
      request(harness.app, `/api/admin/projects/${project.id}`, {
        method: 'DELETE',
        ...credentials,
      }),
      request(harness.app, '/api/admin/storage-directories?path=%2F', credentials),
    ];
    for (const [credentials, code] of [
      [{ cookie: owner.cookie }, 'admin_required'],
      [{ token: readToken.token }, 'insufficient_scope'],
    ] as const)
      for (const response of await Promise.all(attempts(credentials))) {
        expect(response.status).toBe(403);
        expect(await errorCode(response)).toBe(code);
      }
    // A global administrator's unrestricted admin token is enough, as for storage backends.
    expect(
      (await request(harness.app, '/api/admin/projects', { token: adminToken.token })).status,
    ).toBe(200);
    // Purging cannot be undone, so it takes a browser session even from a global administrator.
    const tokenPurge = await request(harness.app, `/api/admin/projects/${project.id}`, {
      method: 'DELETE',
      token: adminToken.token,
    });
    expect(tokenPurge.status).toBe(403);
    expect(await errorCode(tokenPurge)).toBe('session_required');
    expect(await adminProjects('?includeArchived=true')).toEqual([
      expect.objectContaining({ id: project.id, archivedAt: expect.any(String) }),
    ]);
    const denied = await harness.database.query(
      "SELECT action,count(*)::int AS count FROM audit_events WHERE project_id=$1 AND outcome='denied' GROUP BY action ORDER BY action",
      [project.id],
    );
    expect(denied.rows).toEqual([
      { action: 'project.archive', count: 1 },
      { action: 'project.purge', count: 3 },
      { action: 'project.restore', count: 2 },
    ]);
  });

  it('管理一覧のメンバー数は直接付与とgroupの利用者だけを数え、Run数はactiveなRunだけを数える', async () => {
    const project = await createProject({ visibility: 'public' });
    const grouped = await login(harness, 'grouped@localhost');
    await harness.database.query(
      "INSERT INTO user_groups(user_id,group_name) VALUES($1,'ml-team'),($2,'ml-team')",
      [grouped.userId, member.userId],
    );
    await entity(
      await request(harness.app, `/api/projects/${project.id}/group-bindings/ml-team`, {
        method: 'PUT',
        cookie: owner.cookie,
        body: { role: 'viewer' },
      }),
      200,
    );
    const experiment = await entity<{ id: string }>(
      await request(harness.app, `/api/projects/${project.id}/experiments`, {
        method: 'POST',
        cookie: member.cookie,
        body: { name: 'Counted' },
      }),
    );
    const runIds: string[] = [];
    for (const name of ['kept', 'deleted'])
      runIds.push(
        (
          await entity<{ id: string }>(
            await request(harness.app, `/api/projects/${project.id}/runs`, {
              method: 'POST',
              cookie: member.cookie,
              body: { experimentId: experiment.id, name, kind: 'training' },
            }),
          )
        ).id,
      );
    await harness.database.query("UPDATE runs SET lifecycle_stage='deleted' WHERE id=$1", [
      runIds[1],
    ]);
    // Someone using the public Project without being a member is not counted.
    await login(harness, 'passerby@localhost');

    expect(await adminProjects()).toEqual([
      expect.objectContaining({
        id: project.id,
        visibility: 'public',
        memberCount: 3,
        runCount: 1,
        archivedAt: null,
      }),
    ]);
  });

  it('アーカイブしたProjectでは、全体管理者が所有者でも自動実行・昇格・Sweepが動かず、Jobも作れない', async () => {
    const fixture = await sweepFixture(harness);
    const projectId = fixture.project.id;
    const sweep = await fixture.createSweep({
      name: 'paused before archive',
      method: 'random',
      searchSpace: { lr: { distribution: 'log_uniform', min: 0.0001, max: 0.1 } },
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 3,
      parallelism: 1,
    });
    await entity(
      await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/pause`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    const queued = await harness.database.query<{ id: string }>(
      "SELECT id FROM jobs WHERE project_id=$1 AND status IN ('queued','claimed','running')",
      [projectId],
    );
    for (const { id } of queued.rows)
      await entity(
        await request(harness.app, `${fixture.basePath}/jobs/${id}/cancel`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
        }),
        200,
      );
    const waitingRun = await fixture.newRun('Never started');
    const globalOwner = { projectId, runAsUserId: fixture.administrator.userId };
    const sweepOwner = { projectId, createdBy: fixture.administrator.userId };
    expect(await hasAutomationOwnerAccess(harness.database, globalOwner)).toBe(true);
    expect(await hasPromotionRunAsAccess(harness.database, globalOwner)).toBe(true);
    expect(await hasSweepOwnerAccess(harness.database, sweepOwner)).toBe(true);
    expect(await listSchedulableSweepIds(harness.database)).toEqual([sweep.id]);

    expect((await archive(projectId, fixture.administrator.cookie)).status).toBe(204);
    expect(await hasAutomationOwnerAccess(harness.database, globalOwner)).toBe(false);
    expect(await hasPromotionRunAsAccess(harness.database, globalOwner)).toBe(false);
    expect(await hasSweepOwnerAccess(harness.database, sweepOwner)).toBe(false);
    expect(await listSchedulableSweepIds(harness.database)).toEqual([]);
    const jobsBefore = await harness.database.query('SELECT count(*)::int AS count FROM jobs');
    await harness.sweepScheduler.tickAll();
    // Every Job passes JobService.insertJob, which refuses an archived Project.
    await expect(
      transaction(harness.database, (connection) =>
        harness.services.jobs.insertJob(connection, {
          run: waitingRun,
          input: { runId: waitingRun.id, targetId: fixture.target.id, gpuIds: [], maxAttempts: 1 },
          attempt: 1,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const jobsAfter = await harness.database.query('SELECT count(*)::int AS count FROM jobs');
    expect(jobsAfter.rows).toEqual(jobsBefore.rows);

    expect((await restore(projectId)).status).toBe(200);
    expect(await hasSweepOwnerAccess(harness.database, sweepOwner)).toBe(true);
    expect(await listSchedulableSweepIds(harness.database)).toEqual([sweep.id]);
  });
});
