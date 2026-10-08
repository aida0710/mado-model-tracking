// Browser check of the Artifact upload manager against an isolated API (port 47080) and Vite (47081).
// It creates a temporary schema in mmt_test, so the shared development API and DB are untouched.
//
//   (cd apps/web && MMT_WEB_API_PROXY_TARGET=http://127.0.0.1:47080 npx vite --port 47081 --strictPort --host 127.0.0.1) &
//   MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55490/mmt_test \
//   MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
//   MMT_SCREENSHOT_DIR=artifacts/verification/<日付>/artifacts-web \
//   npx tsx apps/web/tests/browser-artifact-upload.mjs
//
// tsx is needed because the script starts the API from its TypeScript sources.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { serve } from '@hono/node-server';
import { createArtifactStoresFromEnv } from '@mmt/platform';
import { createApplication } from '../../api/src/app.ts';
import { loadConfig } from '../../api/src/config.ts';
import { migrate } from '../../api/src/db/migrate.ts';
import { serverTimeouts } from '../../api/src/http/serverTimeouts.ts';

const API_PORT = 47080;
const WEB_URL = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:47081';
const MIB = 1024 * 1024;
const LARGE_FILE_BYTES = 200 * MIB;
const MEDIUM_FILE_BYTES = 40 * MIB;
// Retries back off for about 15 seconds before a part gives up, so failure needs a longer wait.
const FAILURE_TIMEOUT_MS = 90_000;
const COMPLETION_TIMEOUT_MS = 180_000;

const databaseUrl = process.env.MMT_TEST_DATABASE_URL;
if (!databaseUrl || !/^\/mmt_test(?:_|$)/.test(new URL(databaseUrl).pathname))
  throw new Error('MMT_TEST_DATABASE_URL must point to the dedicated mmt_test database');
const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;

const schema = `mmt_upload_browser_${randomBytes(4).toString('hex')}`;
const administrator = new pg.Pool({ connectionString: databaseUrl });
await administrator.query(`CREATE SCHEMA ${schema}`);
const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-upload-browser-artifacts-'));
const fileDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-upload-browser-files-'));
const config = loadConfig({
  MMT_DATABASE_URL: databaseUrl,
  AUTH_MODE: 'development',
  PORT: String(API_PORT),
  MMT_WEB_ORIGIN: WEB_URL,
});
const application = createApplication({
  config,
  database,
  stores: createArtifactStoresFromEnv({ ARTIFACT_FILESYSTEM_ROOT: artifactDirectory }),
});
let server;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const results = {};

async function writeRandomFile(filePath, size) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'w');
  try {
    for (let written = 0; written < size; written += 8 * MIB)
      await handle.write(randomBytes(Math.min(8 * MIB, size - written)));
  } finally {
    await handle.close();
  }
  return filePath;
}

async function sha256OfFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true });
}

async function devLogin(page, email, name) {
  await page.goto(WEB_URL);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('表示名').fill(name);
  const [response] = await Promise.all([
    page.waitForResponse((item) => item.url().endsWith('/api/auth/dev-login')),
    page.getByRole('button', { name: '開発モードでログイン', exact: true }).click(),
  ]);
  return (await response.json()).user;
}

/** Records the part numbers each session receives from the browser. */
function watchPartRequests(page) {
  const sent = new Map();
  const responses = [];
  page.on('request', (request) => {
    const match = request.method() === 'PUT' && new URL(request.url()).pathname.match(/\/artifact-uploads\/([^/]+)\/parts\/(\d+)$/);
    if (!match) return;
    const numbers = sent.get(match[1]) ?? [];
    numbers.push(Number(match[2]));
    sent.set(match[1], numbers);
  });
  page.on('response', (response) => {
    if (response.request().method() === 'PUT' && /\/parts\/\d+$/.test(new URL(response.url()).pathname) && response.ok())
      responses.push(response.url());
  });
  return {
    sentSince: (uploadId, from) => (sent.get(uploadId) ?? []).slice(from),
    sentCount: (uploadId) => (sent.get(uploadId) ?? []).length,
    waitForPartResponses: async (count) => {
      const target = responses.length + count;
      while (responses.length < target) await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

/**
 * Lets part 1 through and holds the other parts until released, so pause and cancel happen while
 * the server has exactly one part regardless of how fast the loopback transfer is.
 */
async function holdPartsAfterFirst(page) {
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const handler = async (route) => {
    if (!/\/parts\/1$/.test(new URL(route.request().url()).pathname)) await released;
    // The browser may have aborted the held request in the meantime.
    await route.continue().catch(() => undefined);
  };
  await page.route('**/artifact-uploads/*/parts/*', handler);
  return async () => {
    release();
    await page.unroute('**/artifact-uploads/*/parts/*', handler);
  };
}

try {
  await migrate(database);
  application.artifactUploadFinalizer.start();
  const timeouts = serverTimeouts(config);
  server = serve({ fetch: application.app.fetch, hostname: '127.0.0.1', port: API_PORT, serverOptions: timeouts.serverOptions });

  const largeFile = await writeRandomFile(path.join(fileDirectory, 'large', 'speech-200m.bin'), LARGE_FILE_BYTES);
  const pausedFile = await writeRandomFile(path.join(fileDirectory, 'paused', 'paused-40m.bin'), MEDIUM_FILE_BYTES);
  const canceledFile = await writeRandomFile(path.join(fileDirectory, 'canceled', 'canceled-40m.bin'), MEDIUM_FILE_BYTES);
  const folder = path.join(fileDirectory, 'dataset');
  await mkdir(path.join(folder, 'audio', 'deep'), { recursive: true });
  await writeFile(path.join(folder, 'manifest.jsonl'), '{"audio":"audio/a.wav"}\n');
  await writeFile(path.join(folder, 'audio', 'a.wav'), randomBytes(4096));
  await writeRandomFile(path.join(folder, 'audio', 'deep', 'features.bin'), 9 * MIB);

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const beforeUnloadDialogs = [];
  page.on('dialog', (dialog) => {
    beforeUnloadDialogs.push(dialog.type());
    void dialog.accept();
  });
  const parts = watchPartRequests(page);
  await devLogin(page, 'admin@localhost', '検証管理者');
  const apiPost = async (endpoint, body, method = 'post') => {
    const response = await page.request[method](`${WEB_URL}/api${endpoint}`, { data: body, headers: { Origin: WEB_URL } });
    assert.ok(response.ok(), `${endpoint}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const apiGet = async (endpoint) => {
    const response = await page.request.get(`${WEB_URL}/api${endpoint}`);
    assert.ok(response.ok(), `${endpoint}: ${response.status()}`);
    return response.json();
  };
  const project = await apiPost('/projects', { name: 'Upload manager browser check' });
  const experiment = await apiPost(`/projects/${project.id}/experiments`, { name: 'Uploads' });
  const run = await apiPost(`/projects/${project.id}/runs`, { experimentId: experiment.id, name: 'upload-run', kind: 'training' });
  const runUrl = `${WEB_URL}/projects/${project.id}/runs/${run.id}?tab=artifacts`;
  const runArtifacts = async () => (await apiGet(`/projects/${project.id}/runs/${run.id}/artifacts`)).items;
  const sessions = async (status) => (await apiGet(`/projects/${project.id}/artifact-uploads?status=${status}`)).items;
  const dialog = () => page.getByRole('dialog');
  const row = (artifactPath) => dialog().getByTestId('upload-queue-row').filter({ hasText: artifactPath });
  const openUploadDialog = async () => {
    await page.goto(runUrl);
    await page.getByRole('button', { name: 'Artifactをアップロード' }).click();
    await dialog().waitFor();
  };
  const startSingle = async (filePath) => {
    await dialog().getByLabel('ファイルを選ぶ').setInputFiles(filePath);
    await dialog().getByRole('button', { name: 'アップロードを開始' }).click();
  };

  // 1. Network loss in the middle of 200MiB, then reload and choose the same file again.
  await openUploadDialog();
  await startSingle(largeFile);
  await parts.waitForPartResponses(2);
  await context.setOffline(true);
  await screenshot(page, 'upload-network-lost');
  await row('speech-200m.bin').and(page.locator('[data-status="failed"]')).waitFor({ timeout: FAILURE_TIMEOUT_MS });
  await screenshot(page, 'upload-failed-after-network-loss');
  await context.setOffline(false);
  const [largeSession] = (await sessions('open')).filter((item) => item.path === 'speech-200m.bin');
  assert.ok(largeSession, 'the interrupted session stays open on the server');
  const receivedBeforeResume = (await apiGet(`/projects/${project.id}/artifact-uploads/${largeSession.id}`)).receivedParts.map((part) => part.partNumber);
  assert.ok(receivedBeforeResume.length > 0 && receivedBeforeResume.length < largeSession.partCount);
  await page.reload();
  await page.getByRole('button', { name: 'Artifactをアップロード' }).click();
  await dialog().getByTestId('upload-resumable-session').filter({ hasText: 'speech-200m.bin' }).waitFor();
  await screenshot(page, 'upload-resumable-session-after-reload');
  const sentBeforeResume = parts.sentCount(largeSession.id);
  await startSingle(largeFile);
  await row('speech-200m.bin').and(page.locator('[data-status="completed"]')).waitFor({ timeout: COMPLETION_TIMEOUT_MS });
  const resentParts = parts.sentSince(largeSession.id, sentBeforeResume);
  const expectedMissing = Array.from({ length: largeSession.partCount }, (_, index) => index + 1).filter((number) => !receivedBeforeResume.includes(number));
  assert.deepEqual([...new Set(resentParts)].sort((a, b) => a - b), expectedMissing, 'only the missing parts are sent after reselecting');
  assert.equal(await dialog().getByTestId('upload-resumable-session').count(), 0, 'the resumed session leaves the resumable list');
  await screenshot(page, 'upload-resumed-completed');
  const largeArtifact = (await runArtifacts()).find((artifact) => artifact.path === 'speech-200m.bin');
  assert.ok(largeArtifact);
  assert.equal(largeArtifact.id, largeSession.id);
  const expectedSha256 = await sha256OfFile(largeFile);
  assert.equal(largeArtifact.sha256, expectedSha256);
  const downloaded = await page.request.get(`${WEB_URL}/api/projects/${project.id}/artifacts/${largeArtifact.id}/content`);
  assert.equal(createHash('sha256').update(await downloaded.body()).digest('hex'), expectedSha256);
  results.networkLossResume = { partCount: largeSession.partCount, receivedBeforeResume: receivedBeforeResume.length, resent: resentParts.length, sha256Matches: true };

  // 2. Pause and resume in the same page: the parts the server has are not sent again.
  const releasePausedParts = await holdPartsAfterFirst(page);
  await startSingle(pausedFile);
  await parts.waitForPartResponses(1);
  await row('paused-40m.bin').getByRole('button', { name: '一時停止' }).click();
  await row('paused-40m.bin').and(page.locator('[data-status="paused"]')).waitFor();
  await releasePausedParts();
  const [pausedSession] = (await sessions('open')).filter((item) => item.path === 'paused-40m.bin');
  const receivedWhilePaused = (await apiGet(`/projects/${project.id}/artifact-uploads/${pausedSession.id}`)).receivedParts.map((part) => part.partNumber);
  const sentBeforeUnpause = parts.sentCount(pausedSession.id);
  await row('paused-40m.bin').getByRole('button', { name: '再開' }).click();
  await row('paused-40m.bin').and(page.locator('[data-status="completed"]')).waitFor({ timeout: COMPLETION_TIMEOUT_MS });
  const sentAfterUnpause = parts.sentSince(pausedSession.id, sentBeforeUnpause);
  assert.deepEqual(receivedWhilePaused, [1]);
  assert.deepEqual([...sentAfterUnpause].sort(), [2, 3], 'resume sends only the parts the server lacks');
  assert.equal((await runArtifacts()).find((artifact) => artifact.path === 'paused-40m.bin')?.sha256, await sha256OfFile(pausedFile));
  results.pauseResume = { receivedWhilePaused: receivedWhilePaused.length, sentAfterResume: sentAfterUnpause.length };

  // 3. Cancel: the session is aborted and no Artifact appears.
  const artifactCountBeforeCancel = (await runArtifacts()).length;
  const releaseCanceledParts = await holdPartsAfterFirst(page);
  await startSingle(canceledFile);
  await parts.waitForPartResponses(1);
  await row('canceled-40m.bin').getByRole('button', { name: '取消' }).click();
  await row('canceled-40m.bin').and(page.locator('[data-status="canceled"]')).waitFor();
  await releaseCanceledParts();
  await screenshot(page, 'upload-canceled');
  let abortedSession;
  for (let attempt = 0; attempt < 50 && !abortedSession; attempt += 1) {
    abortedSession = (await sessions('aborted')).find((item) => item.path === 'canceled-40m.bin');
    if (!abortedSession) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(abortedSession, 'the canceled session is aborted on the server');
  assert.equal((await runArtifacts()).length, artifactCountBeforeCancel);
  assert.equal((await sessions('open')).some((item) => item.path === 'canceled-40m.bin'), false);
  results.cancel = { status: abortedSession.status, artifactCountUnchanged: true };

  // 4. Folder upload keeps the folder structure below the destination folder.
  await dialog().getByLabel('フォルダを選ぶ').setInputFiles(folder);
  await dialog().getByLabel('保存先フォルダ').fill('inputs');
  await screenshot(page, 'upload-folder-selected');
  await dialog().getByRole('button', { name: 'アップロードを開始' }).click();
  const folderPaths = ['inputs/dataset/manifest.jsonl', 'inputs/dataset/audio/a.wav', 'inputs/dataset/audio/deep/features.bin'];
  for (const artifactPath of folderPaths)
    await row(artifactPath).and(page.locator('[data-status="completed"]')).waitFor({ timeout: COMPLETION_TIMEOUT_MS });
  const storedPaths = (await runArtifacts()).map((artifact) => artifact.path);
  for (const artifactPath of folderPaths) assert.ok(storedPaths.includes(artifactPath), `${artifactPath} is stored`);
  await screenshot(page, 'upload-queue-completed');
  results.folder = { paths: folderPaths };

  // 5. Leaving during an upload asks first (beforeunload).
  await startSingle(pausedFile);
  await row('paused-40m.bin').last().and(page.locator('[data-status="uploading"]')).waitFor();
  await page.reload();
  assert.ok(beforeUnloadDialogs.includes('beforeunload'), 'reload during an upload shows the leave warning');
  results.beforeUnload = true;

  // 6. A viewer sees no upload button.
  const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const viewerPage = await viewerContext.newPage();
  const viewer = await devLogin(viewerPage, 'viewer@localhost', '閲覧者');
  await apiPost(`/projects/${project.id}/members/${viewer.id}`, { role: 'viewer' }, 'put');
  await viewerPage.goto(runUrl);
  await viewerPage.getByText('speech-200m.bin').first().waitFor();
  assert.equal(await viewerPage.getByRole('button', { name: 'Artifactをアップロード' }).count(), 0);
  await screenshot(viewerPage, 'upload-viewer-no-button');
  results.viewerHasNoButton = true;
  await viewerContext.close();

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify(results, null, 2));
  if (screenshotDirectory) await writeFile(path.join(screenshotDirectory, 'browser-artifact-upload.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser.close();
  await application.artifactUploadFinalizer.stop();
  await application.outbox.stop();
  await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await database.end();
  await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
  await administrator.end();
  await rm(artifactDirectory, { recursive: true, force: true });
  await rm(fileDirectory, { recursive: true, force: true });
}
