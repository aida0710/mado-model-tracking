import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { transaction } from '../src/db/database.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { OidcLoginDeniedError, syncOidcIdentity } from '../src/services/oidcProvisioning.js';
import { createHarness, request, testDatabaseUrl, type Harness } from './harness.js';
import { startMockOidcProvider, type MockOidcClaims } from './mockOidcProvider.js';

const ROLE_MAPPING = '{"mmt-admins":"admin","mmt-users":"user"}';

describe.skipIf(!testDatabaseUrl)('SSO groupの許可判定と全体roleの同期（独立PostgreSQL）', () => {
  let harness: Harness;
  let provider: Awaited<ReturnType<typeof startMockOidcProvider>>;

  function application(settings: Record<string, string> = {}): Hono<ApiEnvironment> {
    const config = loadConfig({
      MMT_DATABASE_URL: testDatabaseUrl,
      AUTH_MODE: 'hybrid',
      OIDC_ISSUER_URL: provider.issuer,
      OIDC_CLIENT_ID: 'mmt-test',
      OIDC_CLIENT_SECRET: 'mock-client-secret',
      OIDC_ALLOW_INSECURE_HTTP: 'true',
      OIDC_ALLOWED_GROUPS: 'mmt-users,mmt-admins',
      OIDC_ROLE_MAPPING_JSON: ROLE_MAPPING,
      ...settings,
    });
    return createApplication({ config, database: harness.database, stores: harness.stores }).app;
  }

  // Runs the browser side of the Authorization Code flow and returns the callback's status.
  async function ssoLogin(app: Hono<ApiEnvironment>, claims: Partial<MockOidcClaims> = {}) {
    provider.resetClaims();
    provider.setClaims(claims);
    const login = await request(app, '/api/auth/login');
    const authorization = await fetch(new URL(login.headers.get('Location')!), {
      redirect: 'manual',
    });
    const callback = await request(app, authorization.headers.get('Location')!, {
      cookie: login.headers.get('Set-Cookie')!.split(';')[0],
    });
    return {
      status: callback.status,
      code: callback.status === 401 ? ((await callback.json()) as { code: string }).code : null,
    };
  }

  async function userCount(): Promise<number> {
    return Number((await harness.database.query('SELECT count(*) FROM users')).rows[0].count);
  }

  async function oidcUser(subject = 'test-subject') {
    const result = await harness.database.query<{ id: string; is_admin: boolean }>(
      `SELECT u.id,u.is_admin FROM users u JOIN user_oidc_identities i ON i.user_id=u.id
      WHERE i.subject=$1`,
      [subject],
    );
    return result.rows[0];
  }

  async function userGroups(userId: string): Promise<string[]> {
    const result = await harness.database.query<{ group_name: string }>(
      'SELECT group_name FROM user_groups WHERE user_id=$1 ORDER BY group_name',
      [userId],
    );
    return result.rows.map((row) => row.group_name);
  }

  async function deniedReasons(): Promise<string[]> {
    const result = await harness.database.query<{ reason: string }>(
      "SELECT details->>'reason' AS reason FROM audit_events WHERE action='auth.oidc.denied' ORDER BY occurred_at",
    );
    return result.rows.map((row) => row.reason);
  }

  async function createLocalUser(options: { username: string; email: string; isAdmin?: boolean }) {
    const user = await harness.database.query<{ id: string }>(
      'INSERT INTO users(username,email,display_name,is_admin) VALUES($1,$2,$1,$3) RETURNING id',
      [options.username, options.email, options.isAdmin ?? false],
    );
    const userId = user.rows[0]!.id;
    // The hash is never verified here; these tests only log in through SSO.
    await harness.database.query(
      'INSERT INTO user_local_credentials(user_id,password_hash) VALUES($1,$2)',
      [userId, 'unused-password-hash'],
    );
    return userId;
  }

  beforeAll(async () => {
    harness = await createHarness();
    provider = await startMockOidcProvider();
  });
  beforeEach(async () => {
    // TRUNCATE users cascades to the whole audit_events table, including system-actor denials.
    await harness.reset();
  });
  afterAll(async () => {
    await provider?.close();
    await harness?.close();
  });

  it('許可groupに入っていなければ401で、usersもuser_groupsも増えない', async () => {
    const app = application();
    expect(await ssoLogin(app, { groups: ['other-team'] })).toEqual({
      status: 401,
      code: 'oidc_authentication_failed',
    });
    expect(await userCount()).toBe(0);
    expect((await harness.database.query('SELECT * FROM user_groups')).rows).toHaveLength(0);
    expect(await deniedReasons()).toEqual(['group_not_allowed']);
  });

  it('許可groupがあればJIT作成し、groupをuser_groupsへ保存して同期を監査に残す', async () => {
    const app = application();
    expect((await ssoLogin(app, { groups: ['mmt-users', 'other-team'] })).status).toBe(302);
    const user = (await oidcUser())!;
    expect(user.is_admin).toBe(false);
    expect(await userGroups(user.id)).toEqual(['mmt-users', 'other-team']);
    const sync = await harness.database.query(
      "SELECT details FROM audit_events WHERE action='auth.oidc.sync'",
    );
    expect(sync.rows).toEqual([
      {
        details: {
          created: true,
          linkedExisting: false,
          globalRoleBefore: 'user',
          globalRoleAfter: 'user',
          groupsAdded: ['mmt-users', 'other-team'],
          groupsRemoved: [],
        },
      },
    ]);
  });

  // OIDC_ADMIN_GROUP alone must behave exactly like the equivalent role mapping.
  describe.each([
    ['OIDC_ROLE_MAPPING_JSON', {}],
    [
      'OIDC_ADMIN_GROUPだけの既存設定',
      { OIDC_ROLE_MAPPING_JSON: '', OIDC_ADMIN_GROUP: 'mmt-admins' },
    ],
  ])('%s', (_name, settings) => {
    it('admin groupを持てば全体管理者になり、外れると次回ログインで外れる', async () => {
      const app = application(settings);
      await createLocalUser({ username: 'recovery', email: 'recovery@localhost', isAdmin: true });
      expect((await ssoLogin(app, { groups: ['mmt-users', 'mmt-admins'] })).status).toBe(302);
      expect((await oidcUser())!.is_admin).toBe(true);
      expect((await ssoLogin(app, { groups: ['mmt-users'] })).status).toBe(302);
      const user = (await oidcUser())!;
      expect(user.is_admin).toBe(false);
      expect(await userGroups(user.id)).toEqual(['mmt-users']);
      const roles = await harness.database.query(
        "SELECT details->>'globalRoleAfter' AS role FROM audit_events WHERE action='auth.oidc.sync' ORDER BY occurred_at",
      );
      expect(roles.rows.map((row) => row.role)).toEqual(['admin', 'user']);
    });

    it('最後の全体管理者を外す同期は401(last_admin)で、is_adminが残る', async () => {
      const app = application(settings);
      expect((await ssoLogin(app, { groups: ['mmt-admins'] })).status).toBe(302);
      expect(await ssoLogin(app, { groups: ['mmt-users'] })).toEqual({
        status: 401,
        code: 'oidc_authentication_failed',
      });
      const user = (await oidcUser())!;
      expect(user.is_admin).toBe(true);
      expect(await userGroups(user.id)).toEqual(['mmt-admins']);
      expect(await deniedReasons()).toEqual(['last_admin']);
    });
  });

  it('無効化したローカル管理者は残る全体管理者に数えない', async () => {
    const app = application();
    const localAdmin = await createLocalUser({
      username: 'retired',
      email: 'retired@localhost',
      isAdmin: true,
    });
    await harness.database.query("UPDATE users SET status='disabled' WHERE id=$1", [localAdmin]);
    expect((await ssoLogin(app, { groups: ['mmt-admins'] })).status).toBe(302);
    expect((await ssoLogin(app, { groups: ['mmt-users'] })).code).toBe(
      'oidc_authentication_failed',
    );
    expect(await deniedReasons()).toEqual(['last_admin']);
  });

  it('自動連携が無効なら、同じemailのローカルユーザーとは別のユーザーになる', async () => {
    const app = application();
    const localUserId = await createLocalUser({ username: 'alice', email: 'Alice@example.test' });
    expect(
      (await ssoLogin(app, { email: 'alice@example.test', groups: ['mmt-users'] })).status,
    ).toBe(302);
    expect((await oidcUser())!.id).not.toBe(localUserId);
    expect(await userCount()).toBe(2);
  });

  it('自動連携が有効なら、特権の無いローカルユーザーに検証済みemailで連携する', async () => {
    const app = application({ OIDC_AUTO_LINK_VERIFIED_EMAIL: 'true' });
    const localUserId = await createLocalUser({ username: 'alice', email: 'Alice@example.test' });
    expect(
      (await ssoLogin(app, { email: 'alice@example.test', groups: ['mmt-users'] })).status,
    ).toBe(302);
    expect((await oidcUser())!.id).toBe(localUserId);
    expect(await userCount()).toBe(1);
    const sync = await harness.database.query(
      "SELECT details->>'linkedExisting' AS linked FROM audit_events WHERE action='auth.oidc.sync'",
    );
    expect(sync.rows).toEqual([{ linked: 'true' }]);
  });

  it('自動連携が有効でも、全体管理者やProject adminのローカルユーザーには401(privileged_link_required)', async () => {
    const app = application({ OIDC_AUTO_LINK_VERIFIED_EMAIL: 'true' });
    await createLocalUser({ username: 'root', email: 'root@example.test', isAdmin: true });
    const projectAdmin = await createLocalUser({ username: 'lead', email: 'lead@example.test' });
    const project = await harness.database.query<{ id: string }>(
      "INSERT INTO projects(name) VALUES('speech') RETURNING id",
    );
    await harness.database.query(
      "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')",
      [project.rows[0]!.id, projectAdmin],
    );
    for (const email of ['root@example.test', 'lead@example.test'])
      expect((await ssoLogin(app, { email, groups: ['mmt-users'] })).status).toBe(401);
    expect(await userCount()).toBe(2);
    expect(await deniedReasons()).toEqual(['privileged_link_required', 'privileged_link_required']);
    expect((await harness.database.query('SELECT * FROM user_oidc_identities')).rows).toHaveLength(
      0,
    );
  });

  it('email_verified=falseは自動連携が有効でも拒否する', async () => {
    const app = application({ OIDC_AUTO_LINK_VERIFIED_EMAIL: 'true' });
    await createLocalUser({ username: 'alice', email: 'alice@example.test' });
    expect(
      (
        await ssoLogin(app, {
          email: 'alice@example.test',
          emailVerified: false,
          groups: ['mmt-users'],
        })
      ).status,
    ).toBe(401);
    expect(await userCount()).toBe(1);
    expect(await deniedReasons()).toEqual(['email_not_verified']);
  });

  it('無効化したSSOユーザーは401(user_disabled)でsessionを作らない', async () => {
    const app = application();
    expect((await ssoLogin(app, { groups: ['mmt-users'] })).status).toBe(302);
    await harness.database.query("UPDATE users SET status='disabled'");
    await harness.database.query('DELETE FROM sessions');
    expect((await ssoLogin(app, { groups: ['mmt-users'] })).status).toBe(401);
    expect((await harness.database.query('SELECT * FROM sessions')).rows).toHaveLength(0);
    expect(await deniedReasons()).toEqual(['user_disabled']);
  });

  it('syncOidcIdentityは連携済みユーザーへ現在のgroupを反映し、許可groupが無ければ拒否する', async () => {
    const app = application();
    expect((await ssoLogin(app, { groups: ['mmt-users'] })).status).toBe(302);
    const user = (await oidcUser())!;
    const config = loadConfig({
      MMT_DATABASE_URL: testDatabaseUrl,
      AUTH_MODE: 'oidc',
      OIDC_ISSUER_URL: provider.issuer,
      OIDC_CLIENT_ID: 'mmt-test',
      OIDC_ALLOW_INSECURE_HTTP: 'true',
      OIDC_ALLOWED_GROUPS: 'mmt-users,mmt-admins',
      OIDC_ROLE_MAPPING_JSON: ROLE_MAPPING,
    });
    const claims = {
      issuer: provider.issuer,
      subject: 'test-subject',
      email: 'oidc@example.test',
      emailVerified: true,
      displayName: 'OIDC Test User',
    };
    const synced = await transaction(harness.database, (connection) =>
      syncOidcIdentity(connection, {
        userId: user.id,
        claims: { ...claims, groups: ['mmt-users', 'mmt-admins'] },
        rolePolicy: config.oidc!.rolePolicy,
      }),
    );
    expect(synced.isAdmin).toBe(true);
    expect(await userGroups(user.id)).toEqual(['mmt-admins', 'mmt-users']);
    const denial = await transaction(harness.database, (connection) =>
      syncOidcIdentity(connection, {
        userId: user.id,
        claims: { ...claims, groups: ['other-team'] },
        rolePolicy: config.oidc!.rolePolicy,
      }),
    ).catch((error: unknown) => error);
    expect(denial).toBeInstanceOf(OidcLoginDeniedError);
    expect((denial as OidcLoginDeniedError).reason).toBe('group_not_allowed');
    expect(await userGroups(user.id)).toEqual(['mmt-admins', 'mmt-users']);
  });
});
