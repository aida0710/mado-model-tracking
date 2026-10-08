import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { Hono } from 'hono';
import { createArtifactStoresFromEnv } from '@mmt/platform';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import type { ApiEnvironment } from '../src/http/request.js';

export const testDatabaseUrl =
  process.env.MMT_TEST_DATABASE_URL ?? process.env.MMT_DATABASE_URL_TEST;

export async function createHarness(options: { applyMigrations?: boolean } = {}) {
  if (!testDatabaseUrl) throw new Error('MMT_TEST_DATABASE_URL is required for integration tests');
  const url = new URL(testDatabaseUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/mmt_test(?:_|$)/.test(url.pathname)
  )
    throw new Error('Integration tests require the dedicated loopback mmt_test database');
  const schema = `mmt_api_test_${randomBytes(6).toString('hex')}`;
  const administrator = new pg.Pool({ connectionString: testDatabaseUrl });
  await administrator.query(`CREATE SCHEMA ${schema}`);
  const database = new pg.Pool({
    connectionString: testDatabaseUrl,
    options: `-c search_path=${schema}`,
    max: 12,
  });
  const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-api-artifacts-'));
  const config = loadConfig({
    MMT_DATABASE_URL: testDatabaseUrl,
    AUTH_MODE: 'development',
    MMT_ALLOW_LOCAL_EXECUTOR: 'true',
    MMT_ALLOW_SEED: 'true',
  });
  const stores = createArtifactStoresFromEnv({ ARTIFACT_FILESYSTEM_ROOT: artifactDirectory });
  try {
    if (options.applyMigrations !== false) await migrate(database);
  } catch (error) {
    await database.end();
    await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.end();
    await rm(artifactDirectory, { recursive: true, force: true });
    throw error;
  }
  const application = createApplication({ config, database, stores });
  return {
    ...application,
    database,
    config,
    stores,
    artifactDirectory,
    async reset() {
      await database.query('TRUNCATE users,projects,compute_targets CASCADE');
    },
    async close() {
      await application.outbox.stop();
      await database.end();
      await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
      await administrator.end();
      await rm(artifactDirectory, { recursive: true, force: true });
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function request(
  app: Hono<ApiEnvironment>,
  endpoint: string,
  options: {
    method?: string;
    cookie?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    binary?: BodyInit;
  } = {},
): Promise<Response> {
  return app.request(endpoint, {
    method: options.method ?? 'GET',
    headers: {
      Origin: 'http://127.0.0.1:5182',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.binary !== undefined ? { body: options.binary } : {}),
  });
}

export async function login(
  harness: Harness,
  email = 'admin@localhost',
): Promise<{ cookie: string; userId: string }> {
  const response = await request(harness.app, '/api/auth/dev-login', {
    method: 'POST',
    body: { email },
  });
  if (response.status !== 200)
    throw new Error(`Development login failed with HTTP ${response.status}`);
  const entity = (await response.json()) as { user: { id: string } };
  return { cookie: response.headers.get('Set-Cookie')!.split(';')[0]!, userId: entity.user.id };
}

export async function entity<T>(response: Response, expectedStatus = 201): Promise<T> {
  if (response.status !== expectedStatus)
    throw new Error(
      `Expected HTTP ${expectedStatus}, received ${response.status}: ${((await response.json()) as { error: string }).error}`,
    );
  return response.json() as Promise<T>;
}
