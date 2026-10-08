import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CurrentApiToken, Job, ServiceAccount, TokenSummary, WorkerJob } from '@mmt/contracts';
import { argon2idPasswordHasher } from '../src/auth/passwordHasher.js';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { transaction } from '../src/db/database.js';
import { createOidcRolePolicy } from '../src/domain/oidcRolePolicy.js';
import { TOKEN_LAST_USED_WRITE_INTERVAL_SECONDS } from '../src/repositories/identityRepository.js';
import { OidcLoginDeniedError, provisionOidcLogin } from '../src/services/oidcProvisioning.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture, projectFixture } from './fixtures.js';

type ProjectFixture = Awaited<ReturnType<typeof projectFixture>>;
type IssuedToken = { token: string; item: TokenSummary };

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

describe.skipIf(!testDatabaseUrl)('Service AccountとProjectのtoken一覧（独立PostgreSQL）', () => {
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

  function createServiceAccount(
    fixture: ProjectFixture,
    account: { name: string; role: 'viewer' | 'editor' | 'admin' },
    cookie = fixture.administrator.cookie,
  ) {
    return request(harness.app, `${fixture.basePath}/service-accounts`, {
      method: 'POST',
      cookie,
      body: { ...account, description: `${account.name} for tests` },
    });
  }

  async function serviceAccount(
    fixture: ProjectFixture,
    account: { name: string; role: 'viewer' | 'editor' | 'admin' },
  ): Promise<ServiceAccount> {
    return entity<ServiceAccount>(await createServiceAccount(fixture, account));
  }

  function issueServiceAccountToken(
    fixture: ProjectFixture,
    account: ServiceAccount,
    body: { scopes: string[]; expiresAt?: string },
    cookie = fixture.administrator.cookie,
  ) {
    return request(harness.app, `${fixture.basePath}/service-accounts/${account.id}/tokens`, {
      method: 'POST',
      cookie,
      body: { name: `${account.name} key`, ...body },
    });
  }

  function updateServiceAccount(
    fixture: ProjectFixture,
    account: ServiceAccount,
    body: Record<string, unknown>,
  ) {
    return request(harness.app, `${fixture.basePath}/service-accounts/${account.id}`, {
      method: 'PATCH',
      cookie: fixture.administrator.cookie,
      body,
    });
  }

  function createRunWith(fixture: ProjectFixture, token: string, name: string) {
    return request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      token,
      body: { experimentId: fixture.experiment.id, name, kind: 'processing' },
    });
  }

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { code: string }).code;
  }

  it('Service Accountのworker tokenでJobをclaimでき、GET /auth/tokenがscopeを返す', async () => {
    const fixture = await executionFixture(harness);
    const worker = await serviceAccount(fixture, { name: 'gpu-worker', role: 'admin' });
    const issued = await entity<IssuedToken>(
      await issueServiceAccountToken(fixture, worker, { scopes: ['read', 'worker:execute'] }),
    );
    expect(issued.item).toMatchObject({
      kind: 'service',
      ownerType: 'service_account',
      ownerId: worker.id,
      ownerName: 'gpu-worker',
      legacy: false,
      tokenPrefix: issued.token.slice(0, 12),
    });
    const run = await fixture.newRun('Inference');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const claimed = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: issued.token,
        body: { workerId: 'service-account-worker' },
      }),
      200,
    );
    expect(claimed.item?.job.id).toBe(job.id);
    const current = await entity<CurrentApiToken>(
      await request(harness.app, '/api/auth/token', { token: issued.token }),
      200,
    );
    expect(current).toEqual({
      id: issued.item.id,
      projectId: fixture.project.id,
      scopes: ['read', 'worker:execute'],
      job: false,
    });
  });

  it('発行したProject adminをProjectから外しても、Service Accountのtokenは使い続けられる', async () => {
    const fixture = await projectFixture(harness);
    const issuer = await login(harness, 'issuer@localhost');
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${issuer.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'admin' },
      }),
      200,
    );
    const account = await entity<ServiceAccount>(
      await createServiceAccount(fixture, { name: 'pipeline', role: 'editor' }, issuer.cookie),
    );
    const issued = await entity<IssuedToken>(
      await issueServiceAccountToken(
        fixture,
        account,
        { scopes: ['read', 'runs:write'] },
        issuer.cookie,
      ),
    );
    const stored = await harness.database.query(
      'SELECT user_id,created_by_user_id FROM api_tokens WHERE id=$1',
      [issued.item.id],
    );
    expect(stored.rows[0]).toEqual({ user_id: account.id, created_by_user_id: issuer.userId });
    expect(
      (
        await request(harness.app, `${fixture.basePath}/members/${issuer.userId}`, {
          method: 'DELETE',
          cookie: fixture.administrator.cookie,
        })
      ).status,
    ).toBe(204);
    expect((await createRunWith(fixture, issued.token, 'After issuer left')).status).toBe(201);
  });

  it('Service Accountを無効化するとtokenは次の要求から401になり、新しいtokenも発行できない', async () => {
    const fixture = await projectFixture(harness);
    const account = await serviceAccount(fixture, { name: 'nightly', role: 'editor' });
    const issued = await entity<IssuedToken>(
      await issueServiceAccountToken(fixture, account, { scopes: ['read'] }),
    );
    const projectPath = fixture.basePath;
    expect(
      (await request(harness.app, projectPath + '/experiments', { token: issued.token })).status,
    ).toBe(200);
    const disabled = await entity<ServiceAccount>(
      await updateServiceAccount(fixture, account, { status: 'disabled' }),
      200,
    );
    expect(disabled.status).toBe('disabled');
    const refused = await request(harness.app, projectPath + '/experiments', {
      token: issued.token,
    });
    expect(refused.status).toBe(401);
    const another = await issueServiceAccountToken(fixture, account, { scopes: ['read'] });
    expect(another.status).toBe(409);
    expect(await errorCode(another)).toBe('service_account_disabled');
    await entity(await updateServiceAccount(fixture, account, { status: 'active' }), 200);
    expect(
      (await request(harness.app, projectPath + '/experiments', { token: issued.token })).status,
    ).toBe(200);
  });

  it('Service AccountのRoleをviewerへ下げると、書き込みscopeのtokenも403になる', async () => {
    const fixture = await projectFixture(harness);
    const account = await serviceAccount(fixture, { name: 'writer', role: 'editor' });
    const issued = await entity<IssuedToken>(
      await issueServiceAccountToken(fixture, account, { scopes: ['read', 'runs:write'] }),
    );
    expect((await createRunWith(fixture, issued.token, 'As editor')).status).toBe(201);
    const lowered = await entity<ServiceAccount>(
      await updateServiceAccount(fixture, account, { role: 'viewer' }),
      200,
    );
    expect(lowered.role).toBe('viewer');
    const refused = await createRunWith(fixture, issued.token, 'As viewer');
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe('project_forbidden');
  });

  it('Service AccountのRoleを超えるscopeは422で、作成・変更・発行はProject adminのsessionだけ', async () => {
    const fixture = await projectFixture(harness);
    const account = await serviceAccount(fixture, { name: 'reader', role: 'viewer' });
    const excess = await issueServiceAccountToken(fixture, account, {
      scopes: ['read', 'runs:write'],
    });
    expect(excess.status).toBe(422);
    expect(await errorCode(excess)).toBe('scope_exceeds_role');
    const byEditor = await createServiceAccount(
      fixture,
      { name: 'editor-made', role: 'viewer' },
      fixture.editor.cookie,
    );
    expect(byEditor.status).toBe(403);
    const adminToken = await entity<IssuedToken>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'admin', kind: 'personal', projectId: fixture.project.id, scopes: ['admin'] },
      }),
    );
    const byToken = await request(harness.app, `${fixture.basePath}/service-accounts`, {
      method: 'POST',
      token: adminToken.token,
      body: { name: 'token-made', role: 'viewer' },
    });
    expect(byToken.status).toBe(403);
    expect(await errorCode(byToken)).toBe('session_required');
    const duplicate = await createServiceAccount(fixture, { name: 'READER', role: 'viewer' });
    expect(duplicate.status).toBe(409);
    const listed = await entity<{ items: ServiceAccount[] }>(
      await request(harness.app, `${fixture.basePath}/service-accounts`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(listed.items.map((item) => item.name)).toEqual(['reader']);
    const audit = await harness.database.query(
      `SELECT action,outcome,details->>'ownerType' AS owner_type FROM audit_events
      WHERE action IN ('service_account.create','token.create') AND outcome='success' ORDER BY occurred_at`,
    );
    expect(audit.rows).toEqual([
      { action: 'service_account.create', outcome: 'success', owner_type: null },
      { action: 'token.create', outcome: 'success', owner_type: 'user' },
    ]);
  });

  it('Service Accountはローカルアカウントでも SSO でもloginできず、ユーザー検索にも出ない', async () => {
    const fixture = await projectFixture(harness);
    const account = await serviceAccount(fixture, { name: 'robot', role: 'editor' });
    // Rows added by hand still must not open a login path.
    const password = 'service-account-password';
    await harness.database.query("UPDATE users SET username='robot' WHERE id=$1", [account.id]);
    await harness.database.query(
      'INSERT INTO user_local_credentials(user_id,password_hash) VALUES($1,$2)',
      [account.id, await argon2idPasswordHasher.hash(password)],
    );
    const localApp = createApplication({
      config: loadConfig({ MMT_DATABASE_URL: testDatabaseUrl, AUTH_MODE: 'local' }),
      database: harness.database,
      stores: harness.stores,
    }).app;
    const localLogin = await request(localApp, '/api/auth/local-login', {
      method: 'POST',
      body: { username: 'robot', password },
    });
    expect(localLogin.status).toBe(401);
    await harness.database.query(
      `INSERT INTO user_oidc_identities(issuer,subject,user_id,email_at_login,email_verified)
      VALUES('https://sso.example.test','robot-subject',$1,'robot@example.test',true)`,
      [account.id],
    );
    const denial = await transaction(harness.database, (connection) =>
      provisionOidcLogin(connection, {
        claims: {
          issuer: 'https://sso.example.test',
          subject: 'robot-subject',
          email: 'robot@example.test',
          emailVerified: true,
          displayName: 'Robot',
          groups: ['mmt-users'],
        },
        policy: {
          rolePolicy: createOidcRolePolicy({
            allowedGroups: 'mmt-users',
            roleMappingJson: undefined,
            defaultRole: undefined,
            adminGroup: undefined,
          }),
          autoLinkVerifiedEmail: false,
        },
      }),
    ).catch((error: unknown) => error);
    expect(denial).toBeInstanceOf(OidcLoginDeniedError);
    expect((denial as OidcLoginDeniedError).reason).toBe('service_account');
    const search = await entity<{ items: { id: string }[] }>(
      await request(harness.app, '/api/users?query=robot', {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(search.items).toEqual([]);
  });

  it('Project adminは他人のtokenを一覧で見て失効でき、editorは一覧を読めない', async () => {
    const fixture = await executionFixture(harness);
    const personal = await entity<IssuedToken>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'Notebook',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read', 'runs:write'],
        },
      }),
    );
    const account = await serviceAccount(fixture, { name: 'evaluator', role: 'editor' });
    const accountToken = await entity<IssuedToken>(
      await issueServiceAccountToken(fixture, account, { scopes: ['read'] }),
    );
    const listed = await entity<{ items: (TokenSummary & { token?: string })[] }>(
      await request(harness.app, `${fixture.basePath}/tokens`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    const byName = new Map(listed.items.map((item) => [item.name, item]));
    expect(byName.get('Notebook')).toMatchObject({
      ownerType: 'user',
      ownerId: fixture.editor.userId,
      ownerName: 'editor@localhost',
      tokenPrefix: personal.token.slice(0, 12),
      legacy: false,
    });
    expect(byName.get('evaluator key')).toMatchObject({
      ownerType: 'service_account',
      ownerId: account.id,
      tokenPrefix: accountToken.token.slice(0, 12),
    });
    // The fixture's worker token is a personally owned service token: the legacy form.
    expect(byName.get('Test Worker')).toMatchObject({
      ownerType: 'user',
      legacy: true,
      tokenPrefix: expect.any(String),
    });
    expect(listed.items.every((item) => item.token === undefined)).toBe(true);
    const forEditor = await request(harness.app, `${fixture.basePath}/tokens`, {
      cookie: fixture.editor.cookie,
    });
    expect(forEditor.status).toBe(403);
    expect(
      (
        await request(harness.app, `/api/tokens/${personal.item.id}`, {
          method: 'DELETE',
          cookie: fixture.administrator.cookie,
        })
      ).status,
    ).toBe(204);
    expect((await createRunWith(fixture, personal.token, 'Revoked')).status).toBe(401);
    const revocation = await harness.database.query(
      "SELECT details->>'ownerType' AS owner_type FROM audit_events WHERE action='token.revoke' AND outcome='success'",
    );
    expect(revocation.rows).toEqual([{ owner_type: 'user' }]);
  });

  it('期限は上限365日を超えると422、未指定なら365日後になる', async () => {
    const fixture = await projectFixture(harness);
    const account = await serviceAccount(fixture, { name: 'expiring', role: 'editor' });
    const tooLong = new Date(Date.now() + 366 * DAY_MILLISECONDS).toISOString();
    const refusedPersonal = await request(harness.app, '/api/tokens', {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        name: 'Too long',
        kind: 'personal',
        projectId: fixture.project.id,
        scopes: ['read'],
        expiresAt: tooLong,
      },
    });
    expect(refusedPersonal.status).toBe(422);
    expect(await errorCode(refusedPersonal)).toBe('token_lifetime_exceeded');
    const refusedAccount = await issueServiceAccountToken(fixture, account, {
      scopes: ['read'],
      expiresAt: tooLong,
    });
    expect(refusedAccount.status).toBe(422);
    const beforeIssue = Date.now();
    const issued = await entity<IssuedToken>(
      await issueServiceAccountToken(fixture, account, { scopes: ['read'] }),
    );
    const expiresAt = new Date(issued.item.expiresAt!).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(beforeIssue + 365 * DAY_MILLISECONDS - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 365 * DAY_MILLISECONDS);
    const thirtyDays = new Date(Date.now() + 30 * DAY_MILLISECONDS).toISOString();
    const personal = await entity<IssuedToken>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: '30 days', kind: 'personal', scopes: ['read'], expiresAt: thirtyDays },
      }),
    );
    expect(personal.item.expiresAt).toBe(thirtyDays);
  });

  it('既存の個人所有service tokenは旧形式のまま動き続ける', async () => {
    const fixture = await executionFixture(harness);
    // Tokens issued before migration 033 have neither prefix nor issuer, and may never expire.
    await harness.database.query(
      'UPDATE api_tokens SET token_prefix=NULL,created_by_user_id=NULL,expires_at=NULL WHERE kind=$1',
      ['service'],
    );
    const claimed = await request(harness.app, '/api/worker/claim', {
      method: 'POST',
      token: fixture.workerToken,
      body: { workerId: 'legacy-worker' },
    });
    expect(claimed.status).toBe(200);
    const listed = await entity<{ items: TokenSummary[] }>(
      await request(harness.app, `${fixture.basePath}/tokens`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(listed.items).toEqual([
      expect.objectContaining({
        name: 'Test Worker',
        legacy: true,
        tokenPrefix: null,
        expiresAt: null,
        ownerId: fixture.administrator.userId,
      }),
    ]);
  });

  it('最終使用日時は間隔をあけてだけ更新する', async () => {
    const fixture = await projectFixture(harness);
    const issued = await entity<IssuedToken>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { name: 'Reader', kind: 'personal', projectId: fixture.project.id, scopes: ['read'] },
      }),
    );
    const lastUsedAt = async () =>
      (
        await harness.database.query<{ last_used_at: Date | null }>(
          'SELECT last_used_at FROM api_tokens WHERE id=$1',
          [issued.item.id],
        )
      ).rows[0]!.last_used_at;
    const use = () =>
      request(harness.app, `${fixture.basePath}/experiments`, { token: issued.token });
    expect((await use()).status).toBe(200);
    expect(await lastUsedAt()).not.toBeNull();
    const recent = `now()-make_interval(secs=>${TOKEN_LAST_USED_WRITE_INTERVAL_SECONDS - 60})`;
    await harness.database.query(`UPDATE api_tokens SET last_used_at=${recent} WHERE id=$1`, [
      issued.item.id,
    ]);
    const kept = await lastUsedAt();
    expect((await use()).status).toBe(200);
    expect(await lastUsedAt()).toEqual(kept);
    const stale = `now()-make_interval(secs=>${TOKEN_LAST_USED_WRITE_INTERVAL_SECONDS + 60})`;
    await harness.database.query(`UPDATE api_tokens SET last_used_at=${stale} WHERE id=$1`, [
      issued.item.id,
    ]);
    const old = (await lastUsedAt())!;
    expect((await use()).status).toBe(200);
    expect((await lastUsedAt())!.getTime()).toBeGreaterThan(old.getTime());
  });

  it('adminのService Accountが残っていても、最後の人のProject adminは下げられない', async () => {
    const fixture = await projectFixture(harness);
    await serviceAccount(fixture, { name: 'admin-robot', role: 'admin' });
    const demotion = await request(
      harness.app,
      `${fixture.basePath}/members/${fixture.administrator.userId}`,
      { method: 'PUT', cookie: fixture.administrator.cookie, body: { role: 'viewer' } },
    );
    expect(demotion.status).toBe(409);
    const accounts = await entity<{ items: ServiceAccount[] }>(
      await request(harness.app, `${fixture.basePath}/service-accounts`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    const robot = accounts.items[0]!;
    const lowered = await entity<ServiceAccount>(
      await updateServiceAccount(fixture, robot, { role: 'viewer', description: 'read only' }),
      200,
    );
    expect(lowered).toMatchObject({ role: 'viewer', description: 'read only' });
  });

  it('別ProjectのURLからService Accountは操作できない', async () => {
    const fixture = await projectFixture(harness);
    const account = await serviceAccount(fixture, { name: 'scoped', role: 'viewer' });
    const other = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const crossProject = await request(
      harness.app,
      `/api/projects/${other.id}/service-accounts/${account.id}`,
      { method: 'PATCH', cookie: fixture.administrator.cookie, body: { status: 'disabled' } },
    );
    expect(crossProject.status).toBe(404);
  });
});
