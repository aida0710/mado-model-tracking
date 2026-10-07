import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { startMockOidcProvider } from './mockOidcProvider.js';
import type { ApiEnvironment } from '../src/http/request.js';
import type { Hono } from 'hono';

describe.skipIf(!testDatabaseUrl)(
  'OIDC Authorization Code + PKCE（mock providerと独立PostgreSQL）',
  () => {
    let harness: Harness;
    let provider: Awaited<ReturnType<typeof startMockOidcProvider>>;
    let app: Hono<ApiEnvironment>;
    beforeAll(async () => {
      harness = await createHarness();
      provider = await startMockOidcProvider();
      const config = loadConfig({
        MMT_DATABASE_URL: testDatabaseUrl,
        AUTH_MODE: 'oidc',
        OIDC_ISSUER_URL: provider.issuer,
        OIDC_CLIENT_ID: 'mmt-test',
        OIDC_CLIENT_SECRET: 'mock-client-secret',
        OIDC_ALLOW_INSECURE_HTTP: 'true',
      });
      app = createApplication({ config, database: harness.database, stores: harness.stores }).app;
    });
    beforeEach(async () => {
      await harness.reset();
      provider.wrongNonce(false);
      provider.wrongSignature(false);
    });
    afterAll(async () => {
      await provider?.close();
      await harness?.close();
    });

    async function beginLogin() {
      const login = await request(app, '/api/auth/login');
      expect(login.status).toBe(302);
      const authorizationUrl = new URL(login.headers.get('Location')!);
      expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorizationUrl.searchParams.get('state')).toBeTruthy();
      expect(authorizationUrl.searchParams.get('nonce')).toBeTruthy();
      const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
      expect(authorization.status).toBe(302);
      return {
        callbackUrl: authorization.headers.get('Location')!,
        binding: login.headers.get('Set-Cookie')!.split(';')[0]!,
        state: authorizationUrl.searchParams.get('state')!,
      };
    }

    it('署名・issuer・nonce・PKCEを検証してHttpOnly sessionを作り、再送stateを拒否する', async () => {
      const login = await beginLogin();
      const callback = await request(app, login.callbackUrl, { cookie: login.binding });
      expect(callback.status).toBe(302);
      expect(callback.headers.get('Location')).toBe(harness.config.webOrigin);
      const cookies = callback.headers.getSetCookie();
      const session = cookies.find((cookie) => cookie.startsWith('mmt_session='))!;
      expect(session).toContain('HttpOnly');
      expect(session).toContain('SameSite=Lax');
      const me = await entity<{ user: { email: string; isAdmin: boolean } }>(
        await request(app, '/api/auth/me', { cookie: session.split(';')[0] }),
        200,
      );
      expect(me.user.email).toBe('oidc@example.test');
      expect(me.user.isAdmin).toBe(true);
      expect((await request(app, login.callbackUrl, { cookie: login.binding })).status).toBe(401);
      expect((await harness.database.query('SELECT token_hash FROM sessions')).rows).toHaveLength(
        1,
      );
      expect(
        (await harness.database.query('SELECT token_hash FROM sessions')).rows[0].token_hash,
      ).toMatch(/^[a-f0-9]{64}$/);
    });

    it('ブラウザbindingの欠落・不一致はtoken交換前に拒否する', async () => {
      const login = await beginLogin();
      const before = provider.tokenRequests;
      expect((await request(app, login.callbackUrl)).status).toBe(401);
      expect(
        (await request(app, login.callbackUrl, { cookie: 'mmt_login_binding=wrong-browser' }))
          .status,
      ).toBe(401);
      expect(provider.tokenRequests).toBe(before);
      expect((await request(app, login.callbackUrl, { cookie: login.binding })).status).toBe(302);
    });

    it('wrong nonceやwrong signatureではsessionを作らない', async () => {
      for (const failure of ['nonce', 'signature']) {
        provider.wrongNonce(failure === 'nonce');
        provider.wrongSignature(failure === 'signature');
        const login = await beginLogin();
        const callback = await request(app, login.callbackUrl, { cookie: login.binding });
        expect(callback.status).toBe(401);
        expect((await callback.json()).code).toBe('oidc_authentication_failed');
      }
      expect((await harness.database.query('SELECT * FROM sessions')).rows).toHaveLength(0);
    });

    it('PKCE verifier不一致・期限切れstate・state改ざんを拒否する', async () => {
      const login = await beginLogin();
      const tampered = new URL(login.callbackUrl);
      tampered.searchParams.set('state', 'tampered-state');
      expect((await request(app, tampered.href, { cookie: login.binding })).status).toBe(401);
      await harness.database.query("UPDATE oidc_states SET verifier='wrong-verifier'");
      expect((await request(app, login.callbackUrl, { cookie: login.binding })).status).toBe(401);
      const expired = await beginLogin();
      await harness.database.query("UPDATE oidc_states SET expires_at=now()-interval '1 minute'");
      expect((await request(app, expired.callbackUrl, { cookie: expired.binding })).status).toBe(
        401,
      );
    });

    it('OIDC modeではdev-loginを拒否し、logoutでsessionを失効する', async () => {
      expect(
        (
          await request(app, '/api/auth/dev-login', {
            method: 'POST',
            body: { email: 'admin@localhost' },
          })
        ).status,
      ).toBe(404);
      const login = await beginLogin();
      const callback = await request(app, login.callbackUrl, { cookie: login.binding });
      const session = callback.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('mmt_session='))!
        .split(';')[0]!;
      expect(
        (await request(app, '/api/auth/logout', { method: 'POST', cookie: session })).status,
      ).toBe(204);
      expect((await request(app, '/api/auth/me', { cookie: session })).status).toBe(401);
    });

    it('DB障害時のhealthは503になる', async () => {
      const failure = vi
        .spyOn(harness.database, 'query')
        .mockRejectedValueOnce(new Error('Test database failure'));
      try {
        expect((await request(app, '/api/health')).status).toBe(503);
      } finally {
        failure.mockRestore();
      }
    });

    it('開発の.envに空のOIDC設定があっても起動でき、DATABASE_URLへfallbackする', () => {
      const config = loadConfig({
        MMT_DATABASE_URL: '',
        DATABASE_URL: testDatabaseUrl,
        AUTH_MODE: 'development',
        OIDC_ISSUER_URL: '',
        OIDC_CLIENT_ID: '',
        OIDC_CLIENT_SECRET: '',
      });
      expect(config.databaseUrl).toBe(testDatabaseUrl);
      expect(config.oidc).toBeNull();
      expect(config.host).toBe('127.0.0.1');
      expect(config.port).toBe(4182);
    });
  },
);
