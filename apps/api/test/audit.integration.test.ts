import type { AuditEvent, AuditEventPage, Project, TokenSummary } from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/auth/secrets.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

describe.skipIf(!testDatabaseUrl)('監査ログの記録と参照（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Awaited<ReturnType<typeof projectFixture>>;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function storedEvents(action: string): Promise<AuditEvent[]> {
    const page = await entity<AuditEventPage>(
      await request(harness.app, `/api/audit-events?action=${action}&limit=200`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    return page.items;
  }

  async function mintToken(
    cookie: string,
    body: {
      name: string;
      kind?: string;
      projectId?: string;
      scopes: string[];
      expiresAt?: string;
    },
  ) {
    return entity<{ token: string; item: TokenSummary }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie,
        body: { kind: 'personal', ...body },
      }),
    );
  }

  async function createOtherProject(): Promise<Project> {
    return entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { name: 'Other Project' },
      }),
    );
  }

  it('role変更でproject.member.setが1件増え、旧roleと新roleを残す', async () => {
    const before = await storedEvents('project.member.set');
    await entity(
      await request(
        harness.app,
        `${fixture.basePath}/members/${fixture.viewer.userId}`,
        { method: 'PUT', cookie: fixture.administrator.cookie, body: { role: 'editor' } },
      ),
      200,
    );
    const after = await storedEvents('project.member.set');
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatchObject({
      actorType: 'user',
      actorUserId: fixture.administrator.userId,
      outcome: 'success',
      resourceType: 'project_member',
      resourceId: fixture.viewer.userId,
      projectId: fixture.project.id,
      details: { userId: fixture.viewer.userId, previousRole: 'viewer', role: 'editor' },
    });
  });

  it('token発行と失効で1件ずつ増え、detailsにtoken原文もhashも入らない', async () => {
    // Within the default 365-day lifetime limit.
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const minted = await mintToken(fixture.administrator.cookie, {
      name: 'Audit CI',
      projectId: fixture.project.id,
      scopes: ['runs:write'],
      expiresAt,
    });
    const created = await storedEvents('token.create');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      outcome: 'success',
      resourceType: 'api_token',
      resourceId: minted.item.id,
      projectId: fixture.project.id,
      details: {
        name: 'Audit CI',
        kind: 'personal',
        scopes: ['runs:write'],
        expiresAt,
        ownerType: 'user',
      },
    });

    const revoked = await request(harness.app, `/api/tokens/${minted.item.id}`, {
      method: 'DELETE',
      cookie: fixture.administrator.cookie,
    });
    expect(revoked.status).toBe(204);
    const revocations = await storedEvents('token.revoke');
    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatchObject({
      outcome: 'success',
      resourceId: minted.item.id,
      projectId: fixture.project.id,
      details: { ownerUserId: fixture.administrator.userId, name: 'Audit CI' },
    });

    const stored = await harness.database.query<{ details: string }>(
      "SELECT details::text AS details FROM audit_events WHERE action LIKE 'token.%'",
    );
    for (const row of stored.rows) {
      expect(row.details).not.toContain(minted.token);
      expect(row.details).not.toContain(hashSecret(minted.token));
    }
  });

  it('業務transactionがcommit前に失敗するとrole変更も監査も残らない', async () => {
    // A deferred trigger fails at COMMIT, after both the membership and the audit row were written.
    await harness.database.query(`CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'commit failure'; END; $$`);
    await harness.database.query(`CREATE CONSTRAINT TRIGGER fail_member_commit AFTER INSERT ON audit_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.action='project.member.set')
      EXECUTE FUNCTION fail_commit()`);
    try {
      const response = await request(
        harness.app,
        `${fixture.basePath}/members/${fixture.viewer.userId}`,
        { method: 'PUT', cookie: fixture.administrator.cookie, body: { role: 'admin' } },
      );
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await harness.database.query('DROP TRIGGER fail_member_commit ON audit_events');
      await harness.database.query('DROP FUNCTION fail_commit()');
    }
    const role = await harness.database.query<{ role: string }>(
      'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',
      [fixture.project.id, fixture.viewer.userId],
    );
    expect(role.rows[0]!.role).toBe('viewer');
    const events = await storedEvents('project.member.set');
    expect(events.filter((event) => event.details.role === 'admin')).toHaveLength(0);
  });

  it('権限不足と最後の管理者の降格はdeniedとして記録し、業務の変更は残さない', async () => {
    const forbidden = await request(
      harness.app,
      `${fixture.basePath}/members/${fixture.editor.userId}`,
      { method: 'PUT', cookie: fixture.viewer.cookie, body: { role: 'admin' } },
    );
    expect(forbidden.status).toBe(403);
    const lastAdmin = await request(
      harness.app,
      `${fixture.basePath}/members/${fixture.administrator.userId}`,
      { method: 'PUT', cookie: fixture.administrator.cookie, body: { role: 'viewer' } },
    );
    expect(lastAdmin.status).toBe(409);

    const denied = (await storedEvents('project.member.set')).filter(
      (event) => event.outcome === 'denied',
    );
    expect(denied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: fixture.viewer.userId,
          projectId: fixture.project.id,
          details: { userId: fixture.editor.userId, role: 'admin', code: 'project_forbidden' },
        }),
        expect.objectContaining({
          actorUserId: fixture.administrator.userId,
          details: { userId: fixture.administrator.userId, role: 'viewer', code: 'conflict' },
        }),
      ]),
    );
    expect(denied).toHaveLength(2);
  });

  it('tokenからのtoken発行と他人のtokenの失効はdeniedとして記録する', async () => {
    const adminToken = await mintToken(fixture.administrator.cookie, {
      name: 'Admin automation',
      projectId: fixture.project.id,
      scopes: ['admin'],
    });
    const fromToken = await request(harness.app, '/api/tokens', {
      method: 'POST',
      token: adminToken.token,
      body: { name: 'Nested', kind: 'personal', scopes: ['read'] },
    });
    expect(fromToken.status).toBe(403);
    const personal = await mintToken(fixture.administrator.cookie, {
      name: 'Personal read',
      scopes: ['read'],
    });
    const otherUser = await request(harness.app, `/api/tokens/${personal.item.id}`, {
      method: 'DELETE',
      cookie: fixture.editor.cookie,
    });
    expect(otherUser.status).toBe(403);

    expect(
      (await storedEvents('token.create')).filter((event) => event.outcome === 'denied'),
    ).toEqual([
      expect.objectContaining({
        actorType: 'token',
        actorTokenId: adminToken.item.id,
        details: expect.objectContaining({ name: 'Nested', code: 'session_required' }),
      }),
    ]);
    expect(
      (await storedEvents('token.revoke')).filter((event) => event.outcome === 'denied'),
    ).toEqual([
      expect.objectContaining({
        actorUserId: fixture.editor.userId,
        resourceId: personal.item.id,
        details: expect.objectContaining({ code: 'token_forbidden', ownerType: 'user' }),
      }),
    ]);
  });

  it('Project一覧はProject adminだけが読め、viewer・editor・他Projectの管理者は403', async () => {
    const other = await createOtherProject();
    const path = `${fixture.basePath}/audit-events`;
    for (const cookie of [fixture.viewer.cookie, fixture.editor.cookie, fixture.outsider.cookie]) {
      expect((await request(harness.app, path, { cookie })).status).toBe(403);
    }
    await entity(
      await request(harness.app, `/api/projects/${other.id}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.outsider.cookie,
        body: { role: 'viewer' },
      }),
      200,
    );
    const page = await entity<AuditEventPage>(
      await request(harness.app, path, { cookie: fixture.administrator.cookie }),
      200,
    );
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((event) => event.projectId === fixture.project.id)).toBe(true);
    const otherPage = await entity<AuditEventPage>(
      await request(harness.app, `/api/projects/${other.id}/audit-events`, {
        cookie: fixture.outsider.cookie,
      }),
      200,
    );
    expect(otherPage.items.map((event) => event.projectId)).toEqual([other.id]);
  });

  it('全体一覧はglobal adminのsessionだけが読め、Project限定tokenとProject adminは403', async () => {
    const other = await createOtherProject();
    expect(
      (await request(harness.app, '/api/audit-events', { cookie: fixture.outsider.cookie })).status,
    ).toBe(403);
    const projectToken = await mintToken(fixture.administrator.cookie, {
      name: 'Project admin token',
      projectId: fixture.project.id,
      scopes: ['admin'],
    });
    expect(
      (await request(harness.app, '/api/audit-events', { token: projectToken.token })).status,
    ).toBe(403);
    const projectPage = await entity<AuditEventPage>(
      await request(harness.app, `${fixture.basePath}/audit-events`, {
        token: projectToken.token,
      }),
      200,
    );
    expect(projectPage.items.length).toBeGreaterThan(0);
    expect(
      (
        await request(harness.app, `/api/projects/${other.id}/audit-events`, {
          token: projectToken.token,
        })
      ).status,
    ).toBe(403);

    await entity(
      await request(harness.app, `/api/projects/${other.id}/members/${fixture.viewer.userId}`, {
        method: 'PUT',
        cookie: fixture.outsider.cookie,
        body: { role: 'viewer' },
      }),
      200,
    );
    const all = await entity<AuditEventPage>(
      await request(harness.app, '/api/audit-events?limit=200', {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    const projectScoped = all.items.filter((event) => event.projectId !== null);
    expect(new Set(projectScoped.map((event) => event.projectId))).toEqual(
      new Set([fixture.project.id, other.id]),
    );
    // Login events belong to no Project, so only the global list can show them.
    const projectless = all.items.filter((event) => event.projectId === null);
    expect(projectless.length).toBeGreaterThan(0);
    expect(projectless.every((event) => event.action.startsWith('auth.'))).toBe(true);
    const filtered = await entity<AuditEventPage>(
      await request(harness.app, `/api/audit-events?projectId=${other.id}`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(filtered.items.map((event) => event.projectId)).toEqual([other.id]);
  });

  it('新しい順にlimitずつ返し、cursorで重複なく続きを読める', async () => {
    for (const role of ['editor', 'viewer', 'editor'] as const) {
      await entity(
        await request(harness.app, `${fixture.basePath}/members/${fixture.viewer.userId}`, {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { role },
        }),
        200,
      );
    }
    const path = `${fixture.basePath}/audit-events?action=project.member.set&limit=2`;
    const seen: AuditEvent[] = [];
    let cursor: string | null = null;
    do {
      const page: AuditEventPage = await entity<AuditEventPage>(
        await request(harness.app, cursor ? `${path}&cursor=${cursor}` : path, {
          cookie: fixture.administrator.cookie,
        }),
        200,
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    // The fixture sets two members, then this test changes the role three times.
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((event) => event.id)).size).toBe(5);
    expect(seen[0]!.details).toMatchObject({ previousRole: 'viewer', role: 'editor' });
    const times = seen.map((event) => Date.parse(event.occurredAt));
    expect(times).toEqual([...times].sort((left, right) => right - left));

    expect(
      (
        await request(harness.app, `${fixture.basePath}/audit-events?limit=201`, {
          cookie: fixture.administrator.cookie,
        })
      ).status,
    ).toBe(422);
    const other = await createOtherProject();
    await entity(
      await request(harness.app, `/api/projects/${other.id}/members/${fixture.viewer.userId}`, {
        method: 'PUT',
        cookie: fixture.outsider.cookie,
        body: { role: 'viewer' },
      }),
      200,
    );
    const [foreignEvent] = await storedEvents('project.member.set');
    expect(foreignEvent!.projectId).toBe(other.id);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/audit-events?cursor=${foreignEvent!.id}`, {
          cookie: fixture.administrator.cookie,
        })
      ).status,
    ).toBe(404);
  });
});
