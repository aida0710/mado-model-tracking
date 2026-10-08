// Browser check of "フォルダから作る" on the Datasets page against an isolated API (port 47030)
// and Vite (47031). It creates a temporary schema in mmt_test, so the shared development API and
// DB are untouched.
//
//   (cd apps/web && MMT_WEB_API_PROXY_TARGET=http://127.0.0.1:47030 npx vite --port 47031 --strictPort --host 127.0.0.1) &
//   MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55490/mmt_test \
//   MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
//   MMT_SCREENSHOT_DIR=artifacts/verification/<日付>/dataset-folder \
//   npx tsx apps/web/tests/browser-dataset-folder.mjs
//
// tsx is needed because the script starts the API from its TypeScript sources.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const API_PORT = 47030;
const WEB_URL = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:47031';
// One second of a 440 Hz tone keeps the spectrogram visible while the file stays small.
const SAMPLE_RATE = 16000;
const TONE_HZ = 440;
const VERSION_TIMEOUT_MS = 60_000;
// Above the 8 MiB single-PUT limit, so the file is sent in parts that can be held back and canceled.
const LARGE_FILE_BYTES = 24 * 1024 * 1024;
const PART_DELAY_MS = 3000;

const databaseUrl = process.env.MMT_TEST_DATABASE_URL;
if (!databaseUrl || !/^\/mmt_test(?:_|$)/.test(new URL(databaseUrl).pathname))
  throw new Error('MMT_TEST_DATABASE_URL must point to the dedicated mmt_test database');
const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;

const schema = `mmt_dataset_browser_${randomBytes(4).toString('hex')}`;
const administrator = new pg.Pool({ connectionString: databaseUrl });
await administrator.query(`CREATE SCHEMA ${schema}`);
const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-dataset-browser-artifacts-'));
const fileDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-dataset-browser-files-'));
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

function sineWave() {
  const samples = SAMPLE_RATE;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(36 + samples * 2, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(SAMPLE_RATE, 24);
  wave.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++)
    wave.writeInt16LE(Math.round(Math.sin((2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE) * 12000), 44 + index * 2);
  return wave;
}

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true });
}

try {
  await migrate(database);
  server = serve({
    fetch: application.app.fetch,
    hostname: '127.0.0.1',
    port: API_PORT,
    serverOptions: serverTimeouts(config).serverOptions,
  });
  // Multipart uploads are verified by the finalizer, which the API process runs in the background.
  application.artifactUploadFinalizer.start();
  const folder = path.join(fileDirectory, 'speech-corpus');
  await mkdir(path.join(folder, 'train'), { recursive: true });
  await writeFile(path.join(folder, 'train', 'tone.wav'), sineWave());
  await writeFile(path.join(folder, 'train', 'tone-copy.wav'), sineWave());
  await writeFile(path.join(folder, 'manifest.jsonl'), '{"audio":"train/tone.wav","text":"テスト"}\n');

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(WEB_URL);
  await page.getByLabel('メールアドレス').fill('admin@localhost');
  await page.getByLabel('表示名').fill('検証管理者');
  await page.getByRole('button', { name: '開発モードでログイン', exact: true }).click();
  await page.waitForResponse((response) => response.url().endsWith('/api/auth/dev-login'));
  const apiPost = async (endpoint, body) => {
    const response = await page.request.post(`${WEB_URL}/api${endpoint}`, { data: body, headers: { Origin: WEB_URL } });
    assert.ok(response.ok(), `${endpoint}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const project = await apiPost('/projects', { name: 'Dataset folder browser check' });
  const dataset = await apiPost(`/projects/${project.id}/datasets`, { name: 'speech', namespace: 'audio' });

  await page.goto(`${WEB_URL}/projects/${project.id}/datasets`);
  await page.getByRole('button', { name: 'speech', exact: true }).click();
  await page.getByRole('button', { name: 'フォルダから作る' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('フォルダを選択').setInputFiles(folder);
  await dialog.getByText('3件のファイル').waitFor();
  await screenshot(page, 'dataset-folder-selected');
  await dialog.getByRole('button', { name: 'uploadして版を作成' }).click();
  await dialog.waitFor({ state: 'detached', timeout: VERSION_TIMEOUT_MS });

  const versions = await (await page.request.get(`${WEB_URL}/api/projects/${project.id}/datasets/${dataset.id}/versions`)).json();
  assert.equal(versions.items.length, 1);
  const [version] = versions.items;
  assert.equal(version.contentKind, 'artifacts');
  assert.equal(version.fileCount, 3);
  assert.equal(version.uri, `mmt-dataset://${version.id}`);
  const files = await (
    await page.request.get(`${WEB_URL}/api/projects/${project.id}/datasets/${dataset.id}/versions/${version.id}/files`)
  ).json();
  assert.deepEqual(
    files.items.map((file) => file.path),
    ['manifest.jsonl', 'train/tone-copy.wav', 'train/tone.wav'],
  );

  await page.getByRole('button', { name: 'フォルダ train' }).click();
  await page.getByRole('button', { name: 'train/tone.wav' }).click();
  await page.getByRole('button', { name: '再生' }).waitFor();
  await screenshot(page, 'dataset-version-files-audio');

  // A file canceled midway holds the version back; the dialog offers to leave it out or resend it.
  const largeFolder = path.join(fileDirectory, 'with-large');
  await mkdir(path.join(largeFolder, 'sub'), { recursive: true });
  await writeFile(path.join(largeFolder, 'tone.wav'), sineWave());
  await writeFile(path.join(largeFolder, 'sub', 'big.bin'), Buffer.alloc(LARGE_FILE_BYTES, 7));
  // Parts are held back so the large file is still sending when 取消 is pressed.
  await page.route('**/artifact-uploads/*/parts/*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, PART_DELAY_MS));
    // A canceled part's request is gone by the time the delay ends.
    await route.continue().catch(() => undefined);
  });
  async function uploadAndCancelLarge() {
    await page.getByRole('button', { name: 'フォルダから作る' }).click();
    const folderDialog = page.getByRole('dialog');
    await folderDialog.getByLabel('フォルダを選択').setInputFiles(largeFolder);
    await folderDialog.getByText('2件のファイル').waitFor();
    await folderDialog.getByRole('button', { name: 'uploadして版を作成' }).click();
    const largeRow = folderDialog.locator('[data-testid="upload-queue-row"]', { hasText: 'big.bin' });
    await folderDialog.locator('[data-testid="upload-queue-row"][data-status="uploading"]', { hasText: 'big.bin' }).waitFor();
    await folderDialog.locator('[data-testid="upload-queue-row"][data-status="completed"]', { hasText: 'tone.wav' }).waitFor({ timeout: VERSION_TIMEOUT_MS });
    await largeRow.getByRole('button', { name: '取消' }).click();
    await folderDialog.getByText('1件のファイルがuploadされていないため').waitFor();
    return folderDialog;
  }
  const leftOut = await uploadAndCancelLarge();
  await screenshot(page, 'dataset-folder-canceled-choice');
  await leftOut.getByRole('button', { name: '残りのファイルを除いて版を作成' }).click();
  await leftOut.waitFor({ state: 'detached', timeout: VERSION_TIMEOUT_MS });
  const afterLeftOut = await (await page.request.get(`${WEB_URL}/api/projects/${project.id}/datasets/${dataset.id}/versions`)).json();
  assert.equal(afterLeftOut.items.length, 2);
  assert.equal(afterLeftOut.items[0].fileCount, 1);

  const resent = await uploadAndCancelLarge();
  await page.unroute('**/artifact-uploads/*/parts/*');
  await resent.getByRole('button', { name: '残りのファイルを再送' }).click();
  await resent.waitFor({ state: 'detached', timeout: VERSION_TIMEOUT_MS });
  const afterResend = await (await page.request.get(`${WEB_URL}/api/projects/${project.id}/datasets/${dataset.id}/versions`)).json();
  assert.equal(afterResend.items.length, 3);
  assert.equal(afterResend.items[0].fileCount, 2);

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ versionId: version.id, files: files.items.length, canceledFlows: 'passed' }, null, 2));
} finally {
  await browser.close();
  await application.outbox.stop();
  await application.artifactUploadFinalizer.stop();
  await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await database.end();
  await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
  await administrator.end();
  await rm(artifactDirectory, { recursive: true, force: true });
  await rm(fileDirectory, { recursive: true, force: true });
}
