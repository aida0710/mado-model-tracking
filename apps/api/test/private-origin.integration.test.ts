import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app.js';
import { createHarness, request, testDatabaseUrl, type Harness } from './harness.js';

describe.skipIf(!testDatabaseUrl)('プライベートOriginの認証と変更操作（独立PostgreSQL）', () => {
  let harness: Harness;
  let app: Harness['app'];

  beforeAll(async () => {
    harness = await createHarness();
    app = createApplication({
      config: { ...harness.config, allowPrivateOrigins: true },
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

  async function privateLogin(origin = 'http://10.0.10.160:5182'): Promise<string> {
    const response = await request(app, '/api/auth/dev-login', {
      method: 'POST',
      body: {},
      headers: { Origin: origin },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    return response.headers.get('Set-Cookie')!.split(';')[0]!;
  }

  it.each([
    'http://10.0.10.160:5182',
    'http://localhost:5182',
    'https://100.64.0.1:5182',
    'http://[fd00::1]:5182',
  ])('%sからログイン・Project作成・ログアウトができる', async (origin) => {
    const cookie = await privateLogin(origin);
    const created = await request(app, '/api/projects', {
      method: 'POST',
      cookie,
      body: { name: 'Private network' },
      headers: { Origin: origin },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(created.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect((await harness.database.query('SELECT id FROM projects')).rows).toHaveLength(1);
    const logout = await request(app, '/api/auth/logout', {
      method: 'POST',
      cookie,
      headers: { Origin: origin },
    });
    expect(logout.status).toBe(204);
    expect((await request(app, '/api/auth/me', { cookie })).status).toBe(401);
  });

  it('Originが欠落・null・public・偽装の場合はsessionの変更を拒否する', async () => {
    const cookie = await privateLogin();
    for (const origin of [undefined, 'null', 'https://attacker.test', 'http://10.0.0.1.attacker.test']) {
      const headers: Record<string, string> = { Cookie: cookie, 'Content-Type': 'application/json' };
      if (origin !== undefined) headers.Origin = origin;
      const response = await app.request('/api/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Rejected' }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('invalid_origin');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect((await harness.database.query('SELECT id FROM projects')).rows).toHaveLength(0);
  });

  it('CORSのpreflightも同じ許可判定でOriginを返す', async () => {
    for (const origin of ['http://10.0.10.160:5182', 'https://attacker.test', 'null']) {
      const response = await request(app, '/api/projects', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
        origin.startsWith('http://10.') ? origin : null,
      );
      expect(response.headers.get('Vary')).toContain('Origin');
    }
  });

  it('プライベートOrigin許可を無効にするとログインも拒否する', async () => {
    const response = await request(harness.app, '/api/auth/dev-login', {
      method: 'POST',
      body: {},
      headers: { Origin: 'http://10.0.10.160:5182' },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('invalid_origin');
    expect((await harness.database.query('SELECT token_hash FROM sessions')).rows).toHaveLength(0);
  });

  it('Bearer API tokenはOriginのないSDKリクエストでも利用できる', async () => {
    const cookie = await privateLogin();
    const created = await request(app, '/api/tokens', {
      method: 'POST',
      cookie,
      body: { name: 'SDK origin regression', kind: 'personal', scopes: ['read'] },
      headers: { Origin: 'http://10.0.10.160:5182' },
    });
    expect(created.status).toBe(201);
    const { token } = await created.json();
    const response = await app.request('/api/projects', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });
});
