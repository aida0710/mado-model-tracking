import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type {
  Account,
  AdminUser,
  AdminUserPasswordReset,
  AuthMe,
  ServiceAccount,
} from '@mmt/contracts';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';

const TEMPORARY_PASSWORD = 'first temporary passphrase';

describe.skipIf(!testDatabaseUrl)('全体管理者のユーザー管理（独立PostgreSQL）', () => {
  let harness: Harness;
  // Local logins are refused in the harness's development mode, so they go through this app.
  let localApp: Hono<ApiEnvironment>;

  function adminRequest(
    cookie: string,
    endpoint: string,
    options: { method?: string; body?: unknown } = {},
  ) {
    return request(harness.app, `/api/admin${endpoint}`, { cookie, ...options });
  }

  async function createLocalUser(
    cookie: string,
    user: { username: string; isAdmin?: boolean; password?: string },
  ): Promise<AdminUser> {
    return entity<AdminUser>(
      await adminRequest(cookie, '/users', {
        method: 'POST',
        body: {
          username: user.username,
          displayName: `${user.username} 表示名`,
          email: `${user.username}@example.invalid`,
          password: user.password ?? TEMPORARY_PASSWORD,
          isAdmin: user.isAdmin ?? false,
        },
      }),
    );
  }

  function localLogin(username: string, password: string) {
    return request(localApp, '/api/auth/local-login', {
      method: 'POST',
      body: { username, password },
    });
  }

  async function createSsoUser(email: string): Promise<string> {
    const user = await harness.database.query<{ id: string }>(
      'INSERT INTO users(email,display_name) VALUES($1,$1) RETURNING id',
      [email],
    );
    const userId = user.rows[0]!.id;
    await harness.database.query(
      `INSERT INTO user_oidc_identities(issuer,subject,user_id,email_at_login,email_verified,groups_synced_at)
      VALUES('https://idp.example.invalid',$1,$2,$1,true,now())`,
      [email, userId],
    );
    await harness.database.query(
      "INSERT INTO user_groups(user_id,group_name) VALUES($1,'mmt-users'),($1,'team-a')",
      [userId],
    );
    return userId;
  }

  async function mintToken(
    cookie: string,
    token: { projectId?: string; scopes: string[] },
  ): Promise<string> {
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie,
        body: { name: 'admin-users test', kind: 'personal', ...token },
      }),
    );
    return minted.token;
  }

  async function auditRows(action: string) {
    return (
      await harness.database.query<{ outcome: string; resource_id: string; details: string }>(
        'SELECT outcome,resource_id,details::text AS details FROM audit_events WHERE action=$1 ORDER BY occurred_at',
        [action],
      )
    ).rows;
  }

  beforeAll(async () => {
    harness = await createHarness();
    localApp = createApplication({
      config: loadConfig({ MMT_DATABASE_URL: testDatabaseUrl, AUTH_MODE: 'local' }),
      database: harness.database,
      stores: harness.stores,
    }).app;
  });
  beforeEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('一般ユーザー・Project admin・API tokenは、全体管理者のtokenでも403になる', async () => {
    const fixture = await projectFixture(harness);
    const target = fixture.viewer.userId;
    const projectToken = await mintToken(fixture.administrator.cookie, {
      projectId: fixture.project.id,
      scopes: ['read', 'admin'],
    });
    const readToken = await mintToken(fixture.administrator.cookie, { scopes: ['read'] });
    const adminToken = await mintToken(fixture.administrator.cookie, { scopes: ['admin'] });
    // The fixture's editor is promoted to Project admin to cover that role too.
    await entity(
      await request(
        harness.app,
        `/api/projects/${fixture.project.id}/members/${fixture.editor.userId}`,
        { method: 'PUT', cookie: fixture.administrator.cookie, body: { role: 'admin' } },
      ),
      200,
    );
    const callers = [
      { cookie: fixture.viewer.cookie },
      { cookie: fixture.editor.cookie },
      { token: projectToken },
      { token: readToken },
      { token: adminToken },
    ];
    for (const caller of callers) {
      const attempts = [
        request(harness.app, '/api/admin/users', caller),
        request(harness.app, '/api/admin/users', {
          ...caller,
          method: 'POST',
          body: {
            username: 'intruder',
            displayName: 'Intruder',
            password: TEMPORARY_PASSWORD,
            isAdmin: true,
          },
        }),
        request(harness.app, `/api/admin/users/${target}`, {
          ...caller,
          method: 'PATCH',
          body: { isAdmin: true },
        }),
        request(harness.app, `/api/admin/users/${target}/reset-password`, {
          ...caller,
          method: 'POST',
        }),
      ];
      for (const response of await Promise.all(attempts)) expect(response.status).toBe(403);
    }
    const unchanged = await harness.database.query(
      "SELECT is_admin FROM users WHERE id=$1 OR username='intruder'",
      [target],
    );
    expect(unchanged.rows).toEqual([{ is_admin: false }]);
    expect((await auditRows('admin.user.update')).every((row) => row.outcome === 'denied')).toBe(
      true,
    );
  });

  it('ローカルアカウントを作成すると、初回loginでパスワード変更が求められる', async () => {
    const administrator = await login(harness);
    const created = await createLocalUser(administrator.cookie, { username: 'Alice.Local' });
    expect(created).toMatchObject({
      username: 'alice.local',
      email: 'Alice.Local@example.invalid',
      isAdmin: false,
      status: 'active',
      kind: 'human',
      authSources: ['local'],
      lastLoginAt: null,
    });
    const firstLogin = await entity<AuthMe>(
      await localLogin('alice.local', TEMPORARY_PASSWORD),
      200,
    );
    expect(firstLogin.mustChangePassword).toBe(true);

    const duplicate = await adminRequest(administrator.cookie, '/users', {
      method: 'POST',
      body: {
        username: 'alice.local',
        displayName: 'Other',
        password: TEMPORARY_PASSWORD,
        isAdmin: false,
      },
    });
    expect(duplicate.status).toBe(409);
    const shortPassword = await adminRequest(administrator.cookie, '/users', {
      method: 'POST',
      body: { username: 'bob', displayName: 'Bob', password: 'short', isAdmin: false },
    });
    expect(shortPassword.status).toBe(422);

    const listed = await entity<{ items: AdminUser[] }>(
      await adminRequest(administrator.cookie, '/users?query=ALICE&status=active&kind=human'),
      200,
    );
    expect(listed.items.map((user) => user.username)).toEqual(['alice.local']);
    expect(listed.items[0]!.lastLoginAt).not.toBeNull();
    const disabledOnly = await entity<{ items: AdminUser[] }>(
      await adminRequest(administrator.cookie, '/users?status=disabled'),
      200,
    );
    expect(disabledOnly.items).toEqual([]);

    const [audit] = await auditRows('admin.user.create');
    expect(audit).toMatchObject({ outcome: 'success', resource_id: created.id });
    expect(audit!.details).not.toContain(TEMPORARY_PASSWORD);
  });

  it('無効化するとsessionとtoken（MLflow互換APIを含む）が直ちに401になり、再有効化でtokenだけ戻る', async () => {
    const fixture = await projectFixture(harness);
    const { administrator, editor, project } = fixture;
    const token = await mintToken(editor.cookie, { scopes: ['read'] });
    const mlflowSearch = () =>
      request(
        harness.app,
        `/api/mlflow/projects/${project.id}/api/2.0/mlflow/experiments/search`,
        { method: 'POST', token, body: { max_results: 10 } },
      );
    expect((await request(harness.app, '/api/auth/me', { cookie: editor.cookie })).status).toBe(
      200,
    );
    expect((await mlflowSearch()).status).toBe(200);

    const disabled = await entity<AdminUser>(
      await adminRequest(administrator.cookie, `/users/${editor.userId}`, {
        method: 'PATCH',
        body: { status: 'disabled' },
      }),
      200,
    );
    expect(disabled.status).toBe('disabled');
    expect((await request(harness.app, '/api/auth/me', { cookie: editor.cookie })).status).toBe(
      401,
    );
    expect((await request(harness.app, '/api/tokens', { token })).status).toBe(401);
    expect((await mlflowSearch()).status).toBe(401);

    await entity(
      await adminRequest(administrator.cookie, `/users/${editor.userId}`, {
        method: 'PATCH',
        body: { status: 'active' },
      }),
      200,
    );
    expect((await mlflowSearch()).status).toBe(200);
    expect((await request(harness.app, '/api/auth/me', { cookie: editor.cookie })).status).toBe(
      401,
    );
    const audits = await auditRows('admin.user.update');
    expect(audits.map((row) => row.outcome)).toEqual(['success', 'success']);
    expect(JSON.parse(audits[0]!.details)).toMatchObject({
      changedFields: ['status'],
      before: { status: 'active' },
      after: { status: 'disabled' },
    });
  });

  it('最後の有効な全体管理者は無効化も降格もできず、ほかに管理者がいれば降格できる', async () => {
    const administrator = await login(harness);
    for (const body of [{ status: 'disabled' }, { isAdmin: false }]) {
      const response = await adminRequest(administrator.cookie, `/users/${administrator.userId}`, {
        method: 'PATCH',
        body,
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe('last_global_admin');
    }
    // A disabled administrator does not count as a remaining administrator.
    const dormant = await createLocalUser(administrator.cookie, {
      username: 'dormant-admin',
      isAdmin: true,
    });
    await entity(
      await adminRequest(administrator.cookie, `/users/${dormant.id}`, {
        method: 'PATCH',
        body: { status: 'disabled' },
      }),
      200,
    );
    expect(
      (
        await adminRequest(administrator.cookie, `/users/${administrator.userId}`, {
          method: 'PATCH',
          body: { isAdmin: false },
        })
      ).status,
    ).toBe(409);

    const second = await createLocalUser(administrator.cookie, {
      username: 'second-admin',
      isAdmin: true,
    });
    const demoted = await entity<AdminUser>(
      await adminRequest(administrator.cookie, `/users/${second.id}`, {
        method: 'PATCH',
        body: { isAdmin: false },
      }),
      200,
    );
    expect(demoted.isAdmin).toBe(false);
    expect((await auditRows('admin.user.update')).map((row) => row.outcome)).toEqual([
      'denied',
      'denied',
      'success',
      'denied',
      'success',
    ]);
  });

  it('SSOユーザーの全体管理者権限と表示名は422で、無効化はできる', async () => {
    const administrator = await login(harness);
    const ssoUserId = await createSsoUser('sso.user@example.invalid');
    for (const body of [{ isAdmin: true }, { displayName: '別名' }]) {
      const response = await adminRequest(administrator.cookie, `/users/${ssoUserId}`, {
        method: 'PATCH',
        body,
      });
      expect(response.status).toBe(422);
    }
    const disabled = await entity<AdminUser>(
      await adminRequest(administrator.cookie, `/users/${ssoUserId}`, {
        method: 'PATCH',
        body: { status: 'disabled' },
      }),
      200,
    );
    expect(disabled).toMatchObject({ status: 'disabled', isAdmin: false, authSources: ['oidc'] });
    const reset = await adminRequest(administrator.cookie, `/users/${ssoUserId}/reset-password`, {
      method: 'POST',
    });
    expect(reset.status).toBe(422);
  });

  it('Service Accountを全体管理から無効化すると、Projectの一覧でも無効になり無効化日時が残る', async () => {
    const { administrator, basePath } = await projectFixture(harness);
    const account = await entity<ServiceAccount>(
      await request(harness.app, `${basePath}/service-accounts`, {
        method: 'POST',
        cookie: administrator.cookie,
        body: { name: 'gpu-worker', description: '', role: 'editor' },
      }),
    );
    const disabled = await entity<AdminUser>(
      await adminRequest(administrator.cookie, `/users/${account.id}`, {
        method: 'PATCH',
        body: { status: 'disabled' },
      }),
      200,
    );
    expect(disabled).toMatchObject({ kind: 'service', status: 'disabled' });
    const listed = await entity<{ items: ServiceAccount[] }>(
      await request(harness.app, `${basePath}/service-accounts`, { cookie: administrator.cookie }),
      200,
    );
    expect(listed.items).toEqual([expect.objectContaining({ id: account.id, status: 'disabled' })]);
    const details = await harness.database.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM service_account_details WHERE user_id=$1',
      [account.id],
    );
    expect(details.rows[0]!.disabled_at).not.toBeNull();
  });

  it('パスワード再設定は一時パスワードを1回返し、全sessionを失効させ、旧パスワードは401になる', async () => {
    const administrator = await login(harness);
    const user = await createLocalUser(administrator.cookie, { username: 'carol' });
    const oldLogin = await localLogin('carol', TEMPORARY_PASSWORD);
    expect(oldLogin.status).toBe(200);
    const oldSession = oldLogin.headers.get('Set-Cookie')!.split(';')[0]!;

    const { temporaryPassword } = await entity<AdminUserPasswordReset>(
      await adminRequest(administrator.cookie, `/users/${user.id}/reset-password`, {
        method: 'POST',
      }),
      200,
    );
    expect(Buffer.byteLength(temporaryPassword)).toBeGreaterThanOrEqual(12);
    expect((await request(localApp, '/api/auth/me', { cookie: oldSession })).status).toBe(401);
    expect((await localLogin('carol', TEMPORARY_PASSWORD)).status).toBe(401);
    const newLogin = await entity<AuthMe>(await localLogin('carol', temporaryPassword), 200);
    expect(newLogin.mustChangePassword).toBe(true);

    const [audit] = await auditRows('admin.user.password_reset');
    expect(audit).toMatchObject({ outcome: 'success', resource_id: user.id });
    expect(audit!.details).not.toContain(temporaryPassword);
  });

  it('/accountは自分の認証方式とSSOのgroupを返す', async () => {
    const administrator = await login(harness);
    const account = await entity<Account>(
      await request(harness.app, '/api/account', { cookie: administrator.cookie }),
      200,
    );
    expect(account).toMatchObject({
      user: { id: administrator.userId, isAdmin: true, kind: 'human' },
      groups: [],
      groupsSyncedAt: null,
      sessionAuthMethod: 'development',
    });

    const ssoUserId = await createSsoUser('member@example.invalid');
    // SSO users cannot sign in here without an IdP, so a token stands in for their session.
    await harness.database.query(
      `INSERT INTO api_tokens(user_id,name,kind,token_hash,scopes)
      VALUES($1,'account test','personal',encode(sha256('mmt_account_test'::bytea),'hex'),'{read}')`,
      [ssoUserId],
    );
    const ssoAccount = await entity<Account>(
      await request(harness.app, '/api/account', { token: 'mmt_account_test' }),
      200,
    );
    expect(ssoAccount.groups).toEqual(['mmt-users', 'team-a']);
    expect(ssoAccount.groupsSyncedAt).not.toBeNull();
    expect(ssoAccount.sessionAuthMethod).toBeNull();
  });
});
