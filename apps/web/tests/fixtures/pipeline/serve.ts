/**
 * Verification server for browser-pipeline.mjs: the API in local login mode on a fresh test
 * schema, plus the built Web app on the same origin. Never the running development API/DB.
 *
 * - AUTH_MODE=local. The local executor is allowed here only, so a CPU worker on this machine can
 *   run Jobs; the API normally allows it in development mode alone.
 * - Seeds a global admin (must change the password at first login) and a non-admin user whose
 *   group membership stands in for an Authentik group sync, so a Project group binding applies.
 * - Passwords come from the environment of the caller and are never printed.
 * - SIGTERM drops the schema.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createHarness } from '../../../../api/test/harness.js';
import { argon2idPasswordHasher } from '../../../../api/src/auth/passwordHasher.js';
import { transaction } from '../../../../api/src/db/database.js';
import {
  replaceUserGroups,
  upsertLocalAdministrator,
} from '../../../../api/src/repositories/identityRepository.js';

const port = Number(process.env.MMT_PIPELINE_PORT);
const adminPassword = process.env.MMT_PIPELINE_ADMIN_PASSWORD;
const viewerPassword = process.env.MMT_PIPELINE_VIEWER_PASSWORD;
if (!port || !adminPassword || !viewerPassword)
  throw new Error(
    'MMT_PIPELINE_PORT, MMT_PIPELINE_ADMIN_PASSWORD and MMT_PIPELINE_VIEWER_PASSWORD are required',
  );
// Shared with browser-pipeline.mjs, which logs in as these users.
const users = JSON.parse(
  await readFile(new URL('./users.json', import.meta.url), 'utf8'),
) as {
  admin: { username: string; email: string };
  viewer: { username: string; email: string };
  viewerGroup: string;
};
const webRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../dist');
const origin = `http://127.0.0.1:${port}`;

const harness = await createHarness({
  environment: {
    AUTH_MODE: 'local',
    MMT_PUBLIC_URL: origin,
    MMT_WEB_ORIGIN: origin,
    // Encrypts secrets of storage backends added in the admin screen; this schema is temporary.
    MMT_STORAGE_SECRET_KEY: randomBytes(32).toString('base64'),
  },
  configure: (config) => ({ ...config, allowLocalExecutor: true }),
});
harness.artifactUploadFinalizer.start();

await transaction(harness.database, async (connection) => {
  await upsertLocalAdministrator(connection, {
    ...users.admin,
    displayName: 'Pipeline admin',
    passwordHash: await argon2idPasswordHasher.hash(adminPassword),
  });
  const viewer = await connection.query<{ id: string }>(
    'INSERT INTO users(username,email,display_name,is_admin) VALUES($1,$2,$3,false) RETURNING id',
    [users.viewer.username, users.viewer.email, 'Pipeline viewer'],
  );
  const viewerId = viewer.rows[0]!.id;
  await connection.query(
    'INSERT INTO user_local_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,false)',
    [viewerId, await argon2idPasswordHasher.hash(viewerPassword)],
  );
  await replaceUserGroups(connection, viewerId, [users.viewerGroup]);
});

const indexHtml = await readFile(path.join(webRoot, 'index.html'), 'utf8');
const app = new Hono();
app.route('/', harness.app);
app.use('/*', serveStatic({ root: path.relative(process.cwd(), webRoot) }));
// Client-side routes (/projects/..., /admin) get the app shell.
app.get('*', (context) => context.html(indexHtml));
const server = serve({ hostname: '127.0.0.1', port, fetch: app.fetch });
console.log(`Pipeline verification server listening on ${origin}`);

let isClosing = false;
async function shutdown(): Promise<void> {
  if (isClosing) return;
  isClosing = true;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await harness.artifactUploadFinalizer.stop();
  await harness.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
