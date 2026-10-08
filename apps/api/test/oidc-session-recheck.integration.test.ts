import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { ServiceAccount } from '@mmt/contracts';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { createSession } from '../src/repositories/sessionRepository.js';
import { parseSecretKey } from '../src/security/secretEncryption.js';
import { decryptSessionTokens, type SessionTokens } from '../src/services/oidcSessionVerifier.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { projectFixture } from './fixtures.js';
import {
  startMockOidcProvider,
  TEST_SESSION_ENCRYPTION_KEY,
  type MockLogoutToken,
  type MockOidcClaims,
} from './mockOidcProvider.js';

const RECHECK_SECONDS = 60;
// Past the mock's 300-second access token lifetime, so the next check has to refresh.
const PAST_TOKEN_EXPIRY_SECONDS = 400;
const DAY_SECONDS = 24 * 60 * 60;

describe.skipIf(!testDatabaseUrl)(
  'SSO sessionのUserInfo再確認とback-channel logout（mock providerと独立PostgreSQL）',
  () => {
    let harness: Harness;
    let provider: Awaited<ReturnType<typeof startMockOidcProvider>>;
    let app: Hono<ApiEnvironment>;
    let now = new Date();
    const advance = (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    };

    beforeAll(async () => {
      harness = await createHarness();
      provider = await startMockOidcProvider();
      const config = loadConfig({
        MMT_DATABASE_URL: testDatabaseUrl,
        AUTH_MODE: 'hybrid',
        OIDC_ISSUER_URL: provider.issuer,
        OIDC_CLIENT_ID: 'mmt-test',
        OIDC_CLIENT_SECRET: 'mock-client-secret',
        OIDC_ALLOW_INSECURE_HTTP: 'true',
        OIDC_ALLOWED_GROUPS: 'mmt-users,mmt-admins',
        OIDC_ROLE_MAPPING_JSON: '{"mmt-admins":"admin","mmt-users":"user"}',
        MMT_SESSION_ENCRYPTION_KEY: TEST_SESSION_ENCRYPTION_KEY,
        OIDC_RECHECK_SECONDS: String(RECHECK_SECONDS),
      });
      app = createApplication({
        config,
        database: harness.database,
        stores: harness.stores,
        clock: () => now,
      }).app;
    });
    beforeEach(async () => {
      await harness.reset();
      provider.resetClaims();
      provider.resetBehavior();
      now = new Date();
    });
    afterAll(async () => {
      await provider?.close();
      await harness?.close();
    });

    // Runs the browser side of the Authorization Code flow and returns the session cookie.
    async function ssoLogin(claims: Partial<MockOidcClaims> = {}): Promise<string> {
      provider.resetClaims();
      provider.setClaims(claims);
      const login = await request(app, '/api/auth/login');
      const authorization = await fetch(new URL(login.headers.get('Location')!), {
        redirect: 'manual',
      });
      const callback = await request(app, authorization.headers.get('Location')!, {
        cookie: login.headers.get('Set-Cookie')!.split(';')[0],
      });
      expect(callback.status).toBe(302);
      provider.resetBehavior();
      return sessionCookie(callback);
    }

    // The callback also clears the login binding cookie, so the session cookie is picked by name.
    function sessionCookie(response: Response): string {
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith('mmt_session='));
      return cookie!.split(';')[0]!;
    }

    function me(cookie: string) {
      return request(app, '/api/auth/me', { cookie });
    }

    async function errorCode(response: Response): Promise<string> {
      return ((await response.json()) as { code: string }).code;
    }

    async function ssoUserId(subject = 'test-subject'): Promise<string> {
      const identity = await harness.database.query<{ user_id: string }>(
        'SELECT user_id FROM user_oidc_identities WHERE subject=$1',
        [subject],
      );
      return identity.rows[0]!.user_id;
    }

    async function sessionRows() {
      const sessions = await harness.database.query<{
        revoked_at: Date | null;
        oidc_checked_at: Date | null;
        access_token_enc: Buffer | null;
        refresh_token_enc: Buffer | null;
        token_key_id: string | null;
      }>(
        `SELECT revoked_at,oidc_checked_at,access_token_enc,refresh_token_enc,token_key_id
        FROM sessions ORDER BY created_at`,
      );
      return sessions.rows;
    }

    // Each save re-encrypts with a new nonce, so token changes are compared after decryption.
    async function storedTokens(): Promise<SessionTokens> {
      const session = await harness.database.query<{
        token_hash: string;
        token_key_id: string;
        access_token_enc: Buffer;
        refresh_token_enc: Buffer | null;
      }>(
        'SELECT token_hash,token_key_id,access_token_enc,refresh_token_enc FROM sessions ORDER BY created_at LIMIT 1',
      );
      const row = session.rows[0]!;
      return decryptSessionTokens({
        key: parseSecretKey(TEST_SESSION_ENCRYPTION_KEY),
        tokenHash: row.token_hash,
        encrypted: {
          keyId: row.token_key_id,
          accessToken: row.access_token_enc,
          refreshToken: row.refresh_token_enc,
          expiresAt: null,
        },
      });
    }

    async function recheckAuditReasons(): Promise<string[]> {
      const events = await harness.database.query<{ reason: string }>(
        "SELECT details->>'reason' AS reason FROM audit_events WHERE action='auth.oidc.recheck' ORDER BY occurred_at",
      );
      return events.rows.map((event) => event.reason);
    }

    // Mints an API token row for the user; the value is hashed the same way as issued tokens.
    async function insertToken(userId: string, token: string): Promise<void> {
      await harness.database.query(
        `INSERT INTO api_tokens(user_id,name,kind,token_hash,scopes)
        VALUES($1,'recheck test','personal',encode(sha256($2::bytea),'hex'),'{read}')`,
        [userId, token],
      );
    }

    function postLogoutToken(logoutToken: string) {
      return app.request('/api/auth/oidc/backchannel-logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: logoutToken }).toString(),
      });
    }

    it('再確認の間隔内はUserInfoを呼ばない', async () => {
      const cookie = await ssoLogin({ groups: ['mmt-users'] });
      advance(RECHECK_SECONDS - 5);
      for (let attempt = 0; attempt < 3; attempt++) expect((await me(cookie)).status).toBe(200);
      expect(provider.userInfoRequests).toBe(0);
    });

    it('間隔後は許可groupならchecked_atが進み、access tokenが切れていればrefreshして保存し直す', async () => {
      const cookie = await ssoLogin({ groups: ['mmt-users'] });
      const atLogin = await storedTokens();

      advance(RECHECK_SECONDS + 1);
      expect((await me(cookie)).status).toBe(200);
      expect(provider.userInfoRequests).toBe(1);
      expect(provider.refreshRequests).toBe(0);
      const [afterRecheck] = await sessionRows();
      expect(afterRecheck!.oidc_checked_at!.getTime()).toBe(now.getTime());
      expect(await storedTokens()).toEqual(atLogin);

      advance(PAST_TOKEN_EXPIRY_SECONDS);
      expect((await me(cookie)).status).toBe(200);
      expect(provider.refreshRequests).toBe(1);
      expect(provider.userInfoRequests).toBe(2);
      const [afterRefresh] = await sessionRows();
      expect(afterRefresh!.oidc_checked_at!.getTime()).toBe(now.getTime());
      const refreshed = await storedTokens();
      expect(refreshed.accessToken).not.toBe(atLogin.accessToken);
      expect(refreshed.refreshToken).not.toBe(atLogin.refreshToken);
    });

    it('IdPが期限前にaccess tokenを受け付けなくなっても、refresh tokenが有効なら続けられる', async () => {
      const cookie = await ssoLogin({ groups: ['mmt-users'] });
      provider.revokeAccessTokens();
      advance(RECHECK_SECONDS + 1);
      expect((await me(cookie)).status).toBe(200);
      expect(provider.refreshRequests).toBe(1);
      expect(provider.userInfoRequests).toBe(2);
    });

    it('許可groupから外れると同じidentityの全sessionとgroup・API tokenが止まる', async () => {
      const first = await ssoLogin({ groups: ['mmt-users', 'team-a'] });
      const second = await ssoLogin({ groups: ['mmt-users', 'team-a'] });
      const userId = await ssoUserId();
      await insertToken(userId, 'mmt_recheck_member');
      expect((await request(app, '/api/auth/me', { token: 'mmt_recheck_member' })).status).toBe(
        200,
      );

      provider.setClaims({ groups: ['team-a'] });
      advance(RECHECK_SECONDS + 1);
      expect((await me(first)).status).toBe(401);
      expect((await me(second)).status).toBe(401);
      expect(provider.userInfoRequests).toBe(1);
      expect((await sessionRows()).every((session) => session.revoked_at !== null)).toBe(true);
      expect((await sessionRows()).every((session) => session.access_token_enc === null)).toBe(
        true,
      );
      const groups = await harness.database.query('SELECT 1 FROM user_groups WHERE user_id=$1', [
        userId,
      ]);
      expect(groups.rows).toHaveLength(0);
      const tokenUse = await request(app, '/api/auth/me', { token: 'mmt_recheck_member' });
      expect(tokenUse.status).toBe(401);
      expect(await errorCode(tokenUse)).toBe('identity_sync_required');
      expect(await recheckAuditReasons()).toEqual(['group_not_allowed']);
    });

    it('admin groupから外れるとis_adminがfalseになり、全体管理者の操作は403になる（sessionは続く）', async () => {
      // Another active admin, so removing this one does not hit the last-admin rule.
      await harness.database.query(
        "INSERT INTO users(email,display_name,is_admin) VALUES('other-admin@example.test','Other',true)",
      );
      const cookie = await ssoLogin({ groups: ['mmt-admins'] });
      expect((await request(app, '/api/audit-events', { cookie })).status).toBe(200);

      provider.setClaims({ groups: ['mmt-users'] });
      advance(RECHECK_SECONDS + 1);
      expect((await request(app, '/api/audit-events', { cookie })).status).toBe(403);
      const user = await harness.database.query<{ is_admin: boolean }>(
        'SELECT is_admin FROM users WHERE id=$1',
        [await ssoUserId()],
      );
      expect(user.rows[0]!.is_admin).toBe(false);
      expect((await me(cookie)).status).toBe(200);
    });

    it('IdPに届かなければ503 oidc_unavailableで、sessionは残り復旧後に使える', async () => {
      const cookie = await ssoLogin({ groups: ['mmt-users'] });
      provider.unavailable(true);
      advance(RECHECK_SECONDS + 1);
      const response = await me(cookie);
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe('oidc_unavailable');
      expect((await sessionRows())[0]!.revoked_at).toBeNull();

      provider.unavailable(false);
      expect((await me(cookie)).status).toBe(200);
    });

    it('refresh tokenが失効していればsessionを失効させる', async () => {
      const cookie = await ssoLogin({ groups: ['mmt-users'] });
      provider.revokeAllTokens();
      advance(PAST_TOKEN_EXPIRY_SECONDS);
      expect((await me(cookie)).status).toBe(401);
      expect(provider.refreshRequests).toBe(1);
      expect((await sessionRows())[0]!.revoked_at).not.toBeNull();
      expect(await recheckAuditReasons()).toEqual(['idp_session_revoked']);
    });

    it('refresh tokenが無い（offline_access無し）ならaccess tokenの期限で再ログインを求める', async () => {
      provider.issueRefreshTokens(false);
      provider.setClaims({ groups: ['mmt-users'] });
      const login = await request(app, '/api/auth/login');
      const authorization = await fetch(new URL(login.headers.get('Location')!), {
        redirect: 'manual',
      });
      const callback = await request(app, authorization.headers.get('Location')!, {
        cookie: login.headers.get('Set-Cookie')!.split(';')[0],
      });
      const cookie = sessionCookie(callback);
      expect((await sessionRows())[0]!.refresh_token_enc).toBeNull();

      advance(RECHECK_SECONDS + 1);
      expect((await me(cookie)).status).toBe(200);
      advance(PAST_TOKEN_EXPIRY_SECONDS);
      const userInfoBefore = provider.userInfoRequests;
      expect((await me(cookie)).status).toBe(401);
      expect(provider.userInfoRequests).toBe(userInfoBefore);
      expect(await recheckAuditReasons()).toEqual(['reauthentication_required']);
    });

    it('同じsessionへの同時10リクエストでもUserInfoは1回だけ呼ぶ', async () => {
      const cookie = await ssoLogin({ groups: ['mmt-users'] });
      advance(RECHECK_SECONDS + 1);
      const responses = await Promise.all(Array.from({ length: 10 }, () => me(cookie)));
      expect(responses.map((response) => response.status)).toEqual(Array(10).fill(200));
      expect(provider.userInfoRequests).toBe(1);
    });

    it('DBのaccess/refresh tokenは平文で保存しない', async () => {
      await ssoLogin({ groups: ['mmt-users'] });
      const [session] = await sessionRows();
      expect(session!.token_key_id).toMatch(/^[0-9a-f]{16}$/);
      expect(session!.access_token_enc).toBeInstanceOf(Buffer);
      expect(session!.refresh_token_enc).toBeInstanceOf(Buffer);
      for (const stored of [session!.access_token_enc!, session!.refresh_token_enc!])
        expect(stored.toString('latin1')).not.toMatch(/mock-(access|refresh)-/);
      // The same values come back with the session key, so they are encrypted, not discarded.
      expect(await storedTokens()).toMatchObject({
        accessToken: expect.stringMatching(/^mock-access-/),
        refreshToken: expect.stringMatching(/^mock-refresh-/),
      });
    });

    it('back-channel logoutはsubの全sessionを失効させ、同じjtiの再送は400', async () => {
      const first = await ssoLogin({ groups: ['mmt-users'] });
      const second = await ssoLogin({ groups: ['mmt-users'] });
      const logoutToken = await provider.logoutToken({ subject: 'test-subject' });

      const accepted = await postLogoutToken(logoutToken);
      expect(accepted.status).toBe(200);
      expect((await me(first)).status).toBe(401);
      expect((await me(second)).status).toBe(401);
      expect(provider.userInfoRequests).toBe(0);

      const replayed = await postLogoutToken(logoutToken);
      expect(replayed.status).toBe(400);
      expect(await errorCode(replayed)).toBe('logout_token_replayed');
    });

    it('back-channel logoutがsidだけを名指すと、そのIdP sessionのsessionだけを失効させる', async () => {
      const first = await ssoLogin({ groups: ['mmt-users'] });
      const firstSid = provider.lastSid!;
      const second = await ssoLogin({ groups: ['mmt-users'] });

      expect((await postLogoutToken(await provider.logoutToken({ sid: firstSid }))).status).toBe(
        200,
      );
      expect((await me(first)).status).toBe(401);
      expect((await me(second)).status).toBe(200);
    });

    it('back-channel logoutは署名・aud・iss・iat・events・nonce・subの不正を400で拒否する', async () => {
      const cookie = await ssoLogin({ groups: ['mmt-users'] });
      const broken: MockLogoutToken[] = [
        { subject: 'test-subject', signWithWrongKey: true },
        { subject: 'test-subject', audience: 'another-client' },
        { subject: 'test-subject', issuer: 'https://another-idp.example.test' },
        { subject: 'test-subject', issuedAt: new Date(now.getTime() - 20 * 60 * 1000) },
        { subject: 'test-subject', events: undefined },
        { subject: 'test-subject', events: { 'https://example.test/other-event': {} } },
        { subject: 'test-subject', nonce: 'id-token-nonce' },
        {},
      ];
      for (const token of broken) {
        const response = await postLogoutToken(await provider.logoutToken(token));
        expect(response.status).toBe(400);
        expect(await errorCode(response)).toBe('invalid_logout_token');
      }
      const unsigned = await app.request('/api/auth/oidc/backchannel-logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(unsigned.status).toBe(400);
      expect((await me(cookie)).status).toBe(200);
    });

    it('group同期が期限より古いSSOユーザーのtokenは401 identity_sync_requiredで、ブラウザのloginで戻る', async () => {
      await ssoLogin({ groups: ['mmt-users'] });
      const userId = await ssoUserId();
      await insertToken(userId, 'mmt_recheck_stale');
      await harness.database.query(
        "UPDATE user_oidc_identities SET groups_synced_at=now()-interval '8 days' WHERE user_id=$1",
        [userId],
      );
      const stale = await request(app, '/api/auth/me', { token: 'mmt_recheck_stale' });
      expect(stale.status).toBe(401);
      expect(await errorCode(stale)).toBe('identity_sync_required');

      await ssoLogin({ groups: ['mmt-users'] });
      expect((await request(app, '/api/auth/me', { token: 'mmt_recheck_stale' })).status).toBe(200);
    });

    it('sessionの再確認でもgroup同期の時刻が進み、tokenの期限が延びる', async () => {
      const cookie = await ssoLogin({ groups: ['mmt-users'] });
      const userId = await ssoUserId();
      await harness.database.query(
        "UPDATE user_oidc_identities SET groups_synced_at=now()-interval '8 days' WHERE user_id=$1",
        [userId],
      );
      advance(RECHECK_SECONDS + 1);
      expect((await me(cookie)).status).toBe(200);
      await insertToken(userId, 'mmt_recheck_synced');
      expect((await request(app, '/api/auth/me', { token: 'mmt_recheck_synced' })).status).toBe(
        200,
      );
    });

    it('Service Accountのtokenはgroup同期の期限に関係なく使える', async () => {
      const fixture = await projectFixture(harness);
      const account = await entity<ServiceAccount>(
        await request(harness.app, `${fixture.basePath}/service-accounts`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { name: 'robot', role: 'editor', description: 'worker' },
        }),
      );
      const issued = await entity<{ token: string }>(
        await request(harness.app, `${fixture.basePath}/service-accounts/${account.id}/tokens`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { name: 'robot key', scopes: ['read'] },
        }),
      );
      // Even an SSO identity linked by hand, never synced, does not stop a Service Account.
      await harness.database.query(
        `INSERT INTO user_oidc_identities(issuer,subject,user_id,email_at_login,email_verified)
        VALUES($1,'robot-subject',$2,'robot@example.test',true)`,
        [provider.issuer, account.id],
      );
      advance(30 * DAY_SECONDS);
      expect((await request(app, '/api/auth/me', { token: issued.token })).status).toBe(200);
    });

    it('ローカルsessionとtokenを持たない旧SSO sessionの扱い', async () => {
      const local = await harness.database.query<{ id: string }>(
        "INSERT INTO users(username,email,display_name) VALUES('local-user','local@example.test','Local') RETURNING id",
      );
      const localToken = await createSession(harness.database, {
        userId: local.rows[0]!.id,
        authMethod: 'local',
        absoluteSeconds: 3600,
      });
      advance(DAY_SECONDS);
      expect((await me(`mmt_session=${localToken}`)).status).toBe(200);
      expect(provider.userInfoRequests).toBe(0);

      // An SSO session from before migration 042 has no tokens; the user must log in again.
      const legacyToken = await createSession(harness.database, {
        userId: local.rows[0]!.id,
        authMethod: 'oidc',
        absoluteSeconds: 3600,
      });
      expect((await me(`mmt_session=${legacyToken}`)).status).toBe(401);
      expect(await recheckAuditReasons()).toEqual(['reauthentication_required']);
    });
  },
);
