import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { argon2idPasswordHasher } from '../src/auth/passwordHasher.js';
import { hashSecret } from '../src/auth/secrets.js';
import { bootstrapAdministrator } from '../src/scripts/bootstrapAdmin.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { startMockOidcProvider, TEST_SESSION_ENCRYPTION_KEY } from './mockOidcProvider.js';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a different long passphrase';

describe.skipIf(!testDatabaseUrl)('ローカルアカウントとAUTH_MODE（独立PostgreSQL）', () => {
  let harness: Harness;
  let provider: Awaited<ReturnType<typeof startMockOidcProvider>>;

  // Each app has its own rate limiter, so tests do not share attempt counts.
  function application(mode: 'local' | 'oidc' | 'hybrid'): Hono<ApiEnvironment> {
    const config = loadConfig({
      MMT_DATABASE_URL: testDatabaseUrl,
      AUTH_MODE: mode,
      OIDC_ISSUER_URL: provider.issuer,
      OIDC_CLIENT_ID: 'mmt-test',
      OIDC_ALLOWED_GROUPS: 'mmt-users,mmt-admins',
      OIDC_CLIENT_SECRET: 'mock-client-secret',
      OIDC_ALLOW_INSECURE_HTTP: 'true',
      MMT_SESSION_ENCRYPTION_KEY: TEST_SESSION_ENCRYPTION_KEY,
    });
    return createApplication({ config, database: harness.database, stores: harness.stores }).app;
  }

  async function createLocalUser(
    username: string,
    options: { mustChangePassword?: boolean; status?: 'active' | 'disabled' } = {},
  ): Promise<string> {
    const user = await harness.database.query<{ id: string }>(
      `INSERT INTO users(username,email,display_name,status) VALUES($1,$2,$1,$3) RETURNING id`,
      [username, `${username}@localhost`, options.status ?? 'active'],
    );
    const userId = user.rows[0]!.id;
    await harness.database.query(
      'INSERT INTO user_local_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,$3)',
      [userId, await argon2idPasswordHasher.hash(PASSWORD), options.mustChangePassword ?? false],
    );
    return userId;
  }

  function localLogin(app: Hono<ApiEnvironment>, username: string, password = PASSWORD) {
    return request(app, '/api/auth/local-login', {
      method: 'POST',
      body: { username, password },
    });
  }

  async function sessionCookie(app: Hono<ApiEnvironment>, username: string): Promise<string> {
    const response = await localLogin(app, username);
    expect(response.status).toBe(200);
    return response.headers.get('Set-Cookie')!.split(';')[0]!;
  }

  async function auditRows(action: string) {
    return (
      await harness.database.query(
        'SELECT actor_type,actor_user_id,outcome,details::text AS details FROM audit_events WHERE action=$1 ORDER BY occurred_at',
        [action],
      )
    ).rows;
  }

  beforeAll(async () => {
    harness = await createHarness();
    provider = await startMockOidcProvider();
  });
  beforeEach(async () => {
    await harness.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await provider?.close();
    await harness?.close();
  });

  describe('設定', () => {
    it('modeごとに必須の設定が欠けると起動を拒否し、productionのdevelopmentも拒否する', () => {
      const base = { MMT_DATABASE_URL: testDatabaseUrl };
      expect(() => loadConfig({ ...base, AUTH_MODE: 'oidc' })).toThrow(/OIDC_ISSUER_URL/);
      expect(() => loadConfig({ ...base, AUTH_MODE: 'hybrid' })).toThrow(/OIDC_ISSUER_URL/);
      expect(() => loadConfig({ AUTH_MODE: 'local' })).toThrow(/DATABASE_URL/);
      expect(() =>
        loadConfig({
          ...base,
          NODE_ENV: 'production',
          AUTH_MODE: 'development',
          MMT_PUBLIC_URL: 'https://mmt.example',
          MMT_WEB_ORIGIN: 'https://mmt.example',
        }),
      ).toThrow(/forbidden in production/);
      expect(() =>
        loadConfig({
          ...base,
          AUTH_MODE: 'local',
          AUTH_SESSION_IDLE_SECONDS: '50000',
          AUTH_SESSION_ABSOLUTE_SECONDS: '43200',
        }),
      ).toThrow(/AUTH_SESSION_IDLE_SECONDS/);
      // local mode ignores leftover OIDC settings instead of opening an SSO path.
      const local = loadConfig({ ...base, AUTH_MODE: 'local', OIDC_ISSUER_URL: 'not a url' });
      expect(local.oidc).toBeNull();
      expect(local.session).toEqual({ idleSeconds: 28800, absoluteSeconds: 43200 });
    });

    it('local modeはOIDCの開始とcallbackが404、oidc modeはlocal loginが404、hybridは両方使える', async () => {
      const local = application('local');
      expect(await entity(await request(local, '/api/auth/config'), 200)).toEqual({
        mode: 'local',
        methods: { local: true, oidc: null },
      });
      expect((await request(local, '/api/auth/login')).status).toBe(404);
      expect((await request(local, '/api/auth/callback?state=x&code=y')).status).toBe(404);
      expect(
        (await request(local, '/api/auth/dev-login', { method: 'POST', body: {} })).status,
      ).toBe(404);

      const oidc = application('oidc');
      expect(await entity(await request(oidc, '/api/auth/config'), 200)).toEqual({
        mode: 'oidc',
        methods: { local: false, oidc: { label: 'Authentik', loginUrl: '/api/auth/login' } },
      });
      await createLocalUser('alice');
      const disabled = await localLogin(oidc, 'alice');
      expect(disabled.status).toBe(404);
      expect((await disabled.json()).code).toBe('local_login_disabled');

      const hybrid = application('hybrid');
      expect(
        (await entity<{ methods: unknown }>(await request(hybrid, '/api/auth/config'), 200))
          .methods,
      ).toEqual({ local: true, oidc: { label: 'Authentik', loginUrl: '/api/auth/login' } });
      expect((await localLogin(hybrid, 'alice')).status).toBe(200);
      expect((await request(hybrid, '/api/auth/login')).status).toBe(302);
    });
  });

  describe('local login', () => {
    it('成功するとHttpOnly sessionを発行し、監査にpasswordを残さない', async () => {
      const app = application('local');
      const userId = await createLocalUser('alice');
      const response = await localLogin(app, 'Alice');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        user: { id: userId, username: 'alice', status: 'active', authSources: ['local'] },
        mustChangePassword: false,
      });
      const cookie = response.headers.get('Set-Cookie')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=43200');
      const me = await entity<{ user: { id: string } }>(
        await request(app, '/api/auth/me', { cookie: cookie.split(';')[0] }),
        200,
      );
      expect(me.user.id).toBe(userId);
      const session = await harness.database.query('SELECT auth_method FROM sessions');
      expect(session.rows).toEqual([{ auth_method: 'local' }]);
      const audit = await auditRows('auth.login');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_type: 'user',
        actor_user_id: userId,
        outcome: 'success',
      });
      expect(audit[0].details).not.toContain(PASSWORD);
    });

    it('誤ったpassword・存在しないuser・無効化したuserは同じ401を返す', async () => {
      const app = application('local');
      await createLocalUser('alice');
      await createLocalUser('disabled', { status: 'disabled' });
      const responses = await Promise.all([
        localLogin(app, 'alice', 'wrong password value'),
        localLogin(app, 'nobody'),
        localLogin(app, 'disabled'),
      ]);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
      expect(bodies[0].code).toBe('invalid_credentials');
      expect(responses.some((response) => response.headers.get('Set-Cookie'))).toBe(false);
      const audit = await auditRows('auth.login');
      expect(audit.map((row) => row.outcome)).toEqual(['failed', 'failed', 'failed']);
      for (const row of audit) {
        expect(row.actor_type).toBe('system');
        expect(row.details).not.toContain('wrong password value');
        expect(row.details).not.toContain(PASSWORD);
      }
    });

    it('接続元ごとの上限を超えると429とRetry-Afterを返し、window経過後に回復する', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
      const app = application('local');
      await createLocalUser('alice');
      // Unknown usernames spread failures so only the per-address limit applies.
      for (let attempt = 0; attempt < 30; attempt += 1)
        expect((await localLogin(app, `nobody${attempt}`)).status).toBe(401);
      const limited = await localLogin(app, 'alice');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('Retry-After')).toBe('60');
      expect((await limited.json()).code).toBe('rate_limited');
      vi.setSystemTime(new Date('2026-10-08T00:01:01Z'));
      expect((await localLogin(app, 'alice')).status).toBe(200);
    });

    it('同じusernameへの失敗が続くと正しいpasswordでも429にし、window経過後に回復する', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
      const app = application('local');
      await createLocalUser('alice');
      for (let attempt = 0; attempt < 10; attempt += 1)
        expect((await localLogin(app, 'alice', 'wrong password value')).status).toBe(401);
      expect((await localLogin(app, 'alice')).status).toBe(429);
      vi.setSystemTime(new Date('2026-10-08T00:15:01Z'));
      expect((await localLogin(app, 'alice')).status).toBe(200);
    });

    it('idle期限を過ぎたsessionとlogout後のsessionは401になる', async () => {
      const app = application('local');
      await createLocalUser('alice');
      const idle = await sessionCookie(app, 'alice');
      await harness.database.query(
        "UPDATE sessions SET last_seen_at=now()-interval '8 hours 1 minute'",
      );
      expect((await request(app, '/api/auth/me', { cookie: idle })).status).toBe(401);
      const active = await sessionCookie(app, 'alice');
      expect((await request(app, '/api/auth/me', { cookie: active })).status).toBe(200);
      expect(
        (await request(app, '/api/auth/logout', { method: 'POST', cookie: active })).status,
      ).toBe(204);
      expect((await request(app, '/api/auth/me', { cookie: active })).status).toBe(401);
      expect((await auditRows('auth.logout')).map((row) => row.outcome)).toEqual(['success']);
    });

    it('無効化したuserはsessionもAPI tokenも401になる', async () => {
      const app = application('local');
      const userId = await createLocalUser('alice');
      const cookie = await sessionCookie(app, 'alice');
      const token = 'disabled-user-token-value';
      await harness.database.query(
        "INSERT INTO api_tokens(user_id,name,kind,token_hash,scopes) VALUES($1,'cli','personal',$2,'{read}')",
        [userId, hashSecret(token)],
      );
      expect((await request(app, '/api/auth/me', { token })).status).toBe(200);
      await harness.database.query("UPDATE users SET status='disabled' WHERE id=$1", [userId]);
      expect((await request(app, '/api/auth/me', { cookie })).status).toBe(401);
      const tokenResponse = await request(app, '/api/auth/me', { token });
      expect(tokenResponse.status).toBe(401);
      expect((await tokenResponse.json()).code).toBe('invalid_token');
    });
  });

  describe('パスワード変更', () => {
    it('変更が必要なsessionは他のAPIを403にし、変更すると他のsessionを失効する', async () => {
      const app = application('local');
      await createLocalUser('admin', { mustChangePassword: true });
      const first = await localLogin(app, 'admin');
      expect((await first.json()).mustChangePassword).toBe(true);
      const current = first.headers.get('Set-Cookie')!.split(';')[0]!;
      const other = await sessionCookie(app, 'admin');
      const blocked = await request(app, '/api/projects', { cookie: current });
      expect(blocked.status).toBe(403);
      expect((await blocked.json()).code).toBe('password_change_required');
      expect(
        (
          await entity<{ mustChangePassword: boolean }>(
            await request(app, '/api/auth/me', { cookie: current }),
            200,
          )
        ).mustChangePassword,
      ).toBe(true);

      const weak = await request(app, '/api/auth/change-password', {
        method: 'POST',
        cookie: current,
        body: { currentPassword: PASSWORD, newPassword: 'short' },
      });
      expect(weak.status).toBe(422);
      expect((await weak.json()).code).toBe('weak_password');
      const changed = await request(app, '/api/auth/change-password', {
        method: 'POST',
        cookie: current,
        body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(changed.status).toBe(204);
      expect((await request(app, '/api/projects', { cookie: current })).status).toBe(200);
      expect((await request(app, '/api/auth/me', { cookie: other })).status).toBe(401);
      expect((await localLogin(app, 'admin')).status).toBe(401);
      const relogin = await localLogin(app, 'admin', NEW_PASSWORD);
      expect((await relogin.json()).mustChangePassword).toBe(false);
      const audit = await auditRows('auth.password.change');
      expect(audit.map((row) => row.outcome)).toEqual(['success']);
      expect(audit[0].details).not.toContain(NEW_PASSWORD);
    });

    it('現在のpasswordの誤りは401で、user単位の上限を超えると429になる', async () => {
      const app = application('local');
      await createLocalUser('alice');
      const cookie = await sessionCookie(app, 'alice');
      const attempt = () =>
        request(app, '/api/auth/change-password', {
          method: 'POST',
          cookie,
          body: { currentPassword: 'wrong password value', newPassword: NEW_PASSWORD },
        });
      for (let count = 0; count < 10; count += 1) {
        const response = await attempt();
        expect(response.status).toBe(401);
        expect((await response.json()).code).toBe('invalid_credentials');
      }
      const limited = await attempt();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect((await auditRows('auth.password.change')).map((row) => row.outcome)).toEqual(
        Array(10).fill('failed'),
      );
    });

    it('ローカルアカウントを持たないSSOのsessionは変更できない', async () => {
      const app = application('hybrid');
      const login = await request(app, '/api/auth/login');
      const authorization = await fetch(new URL(login.headers.get('Location')!), {
        redirect: 'manual',
      });
      const callback = await request(app, authorization.headers.get('Location')!, {
        cookie: login.headers.get('Set-Cookie')!.split(';')[0],
      });
      const cookie = callback.headers
        .getSetCookie()
        .find((value) => value.startsWith('mmt_session='))!
        .split(';')[0]!;
      const response = await request(app, '/api/auth/change-password', {
        method: 'POST',
        cookie,
        body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('local_account_required');
    });
  });

  describe('OIDCの識別子', () => {
    it('移行済みのOIDC identityは同じuser.idでloginし、login時のgroupを記録する', async () => {
      const app = application('oidc');
      const legacy = await harness.database.query<{ id: string }>(
        "INSERT INTO users(issuer,subject,email,display_name) VALUES($1,'test-subject','old@example.test','Old') RETURNING id",
        [provider.issuer],
      );
      const userId = legacy.rows[0]!.id;
      await harness.database.query(
        "INSERT INTO user_oidc_identities(issuer,subject,user_id,email_at_login,email_verified) VALUES($1,'test-subject',$2,'old@example.test',true)",
        [provider.issuer, userId],
      );
      const login = await request(app, '/api/auth/login');
      const authorization = await fetch(new URL(login.headers.get('Location')!), {
        redirect: 'manual',
      });
      const callback = await request(app, authorization.headers.get('Location')!, {
        cookie: login.headers.get('Set-Cookie')!.split(';')[0],
      });
      expect(callback.status).toBe(302);
      const cookie = callback.headers
        .getSetCookie()
        .find((value) => value.startsWith('mmt_session='))!
        .split(';')[0]!;
      const me = await entity<{ user: { id: string; email: string; authSources: string[] } }>(
        await request(app, '/api/auth/me', { cookie }),
        200,
      );
      expect(me.user).toMatchObject({
        id: userId,
        email: 'oidc@example.test',
        authSources: ['oidc'],
      });
      const identity = await harness.database.query(
        'SELECT groups_at_login,email_at_login FROM user_oidc_identities WHERE user_id=$1',
        [userId],
      );
      expect(identity.rows).toEqual([
        { groups_at_login: ['mmt-admins'], email_at_login: 'oidc@example.test' },
      ]);
      expect((await auditRows('auth.login'))[0]).toMatchObject({
        actor_user_id: userId,
        outcome: 'success',
      });
    });
  });

  describe('bootstrap-admin', () => {
    it('対話入力から変更必須の管理者を作り、passwordを出力に出さない', async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let printed = '';
      output.on('data', (chunk: Buffer) => {
        printed += chunk.toString('utf8');
      });
      const done = bootstrapAdministrator({
        database: harness.database,
        terminal: { input, output },
      });
      input.write(`Root-Admin\n${PASSWORD}\r\n`);
      input.write(`${PASSWORD}\n`);
      const created = await done;
      expect(created.username).toBe('root-admin');
      expect(printed).toContain('password change required');
      expect(printed).not.toContain(PASSWORD);
      const user = await harness.database.query(
        'SELECT u.is_admin,c.must_change_password,c.password_hash FROM users u JOIN user_local_credentials c ON c.user_id=u.id WHERE u.id=$1',
        [created.userId],
      );
      expect(user.rows[0]).toMatchObject({ is_admin: true, must_change_password: true });
      expect(user.rows[0].password_hash).toMatch(/^\$argon2id\$/);
      const login = await localLogin(application('local'), 'root-admin');
      expect(await login.json()).toMatchObject({
        user: { isAdmin: true },
        mustChangePassword: true,
      });
    });
  });
});
