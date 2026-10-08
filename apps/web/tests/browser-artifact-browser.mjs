// Browser check for the Run Artifact folder tree, earlier versions, the Project-wide catalog,
// and a Run with 10,000 files whose first page must appear without loading everything.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
// Matches RUN_ARTIFACT_PAGE_SIZE in hooks/useRunArtifacts.ts.
const RUN_ARTIFACT_PAGE_SIZE = 200;
const LARGE_RUN_FILE_COUNT = 10_000;
// The first page must not wait for all 10,000 files; generous for a loaded CI machine.
const FIRST_PAGE_BUDGET_MS = 5000;

const api = createBrowserApi();
api.state.loggedIn = true;
const [firstRun, secondRun] = api.state.runs;
const largeRun = { ...secondRun, id: '00000000-0000-4000-8000-000000009999', name: 'large-audio-run' };
api.state.runs.push(largeRun);
const projectId = api.state.project.id;
let sequence = 8000;
const identifier = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const contents = new Map();
function addArtifact({ run, path, body, mimeType = 'text/plain; charset=utf-8', createdAt }) {
  const artifact = {
    id: identifier(),
    projectId,
    runId: run.id,
    path,
    backend: 'filesystem',
    storageKey: path,
    mimeType,
    size: Buffer.byteLength(body),
    sha256: '0'.repeat(64),
    createdAt: createdAt ?? '2026-10-08T00:00:00Z',
  };
  api.state.artifacts.push(artifact);
  contents.set(artifact.id, body);
  return artifact;
}
// The browserApi fixture Artifact would otherwise appear in every listing.
api.state.artifacts.length = 0;
addArtifact({ run: firstRun, path: 'eval/notes.txt', body: 'first evaluation notes' });
addArtifact({ run: firstRun, path: 'eval/summary.txt', body: 'summary of the evaluation' });
addArtifact({ run: firstRun, path: 'eval/deep/a/b/c.txt', body: 'deep file' });
addArtifact({ run: firstRun, path: 'config.txt', body: 'old config', createdAt: '2026-10-07T00:00:00Z' });
const latestConfig = addArtifact({ run: firstRun, path: 'config.txt', body: 'new config' });
// A file and a folder with the same name are both listed.
addArtifact({ run: firstRun, path: 'data', body: 'file named data' });
addArtifact({ run: firstRun, path: 'data/inside.txt', body: 'inside the data folder' });
addArtifact({ run: secondRun, path: 'predictions/notes.txt', body: 'second run notes' });
// Older than the files above so the newest-first catalog page starts with those.
for (let index = 0; index < LARGE_RUN_FILE_COUNT; index += 1)
  addArtifact({
    run: largeRun,
    path: `clips/${String(index).padStart(5, '0')}.txt`,
    body: `clip ${index}`,
    createdAt: '2026-10-01T00:00:00Z',
  });

const artifactListRequests = [];
await context.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const url = new URL(route.request().url());
    if (/\/runs\/[^/]+\/artifacts$/.test(url.pathname) && route.request().method() === 'GET')
      artifactListRequests.push(url.pathname + url.search);
    const match = url.pathname.match(/\/artifacts\/([^/]+)\/content$/);
    if (match && contents.has(match[1]))
      return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: contents.get(match[1]) });
    return api.route(route);
  },
);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const projectBase = `${base}/projects/${projectId}`;

async function screenshot(name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
}
const folder = (name) => page.getByRole('button', { name: `フォルダ ${name}`, exact: true });
const file = (path) => page.getByRole('button', { name: path, exact: true });
const preview = () => page.locator('.artifact-preview');

try {
  console.log('Browser check: folders, preview switching, and earlier versions');
  await page.goto(`${projectBase}/runs/${firstRun.id}?tab=artifacts`);
  await folder('eval').waitFor();
  await folder('data').waitFor();
  await file('data').waitFor();
  assert.equal(await file('eval/notes.txt').count(), 0, 'nested files must stay inside their folder');
  await folder('eval').click();
  await file('eval/notes.txt').click();
  await preview().getByText('first evaluation notes').waitFor();
  await file('eval/summary.txt').click();
  await preview().getByText('summary of the evaluation').waitFor();
  assert.equal(await preview().getByText('first evaluation notes').count(), 0);
  await folder('deep').click();
  await folder('a').click();
  await folder('b').click();
  await file('eval/deep/a/b/c.txt').waitFor();
  await screenshot('artifact-tree-deep');
  await page.locator('.artifact-breadcrumbs').getByRole('button', { name: 'eval' }).click();
  await file('eval/notes.txt').waitFor();
  await page.goBack();
  await file('eval/deep/a/b/c.txt').waitFor();
  await page.locator('.artifact-breadcrumbs').getByRole('button', { name: 'ルート' }).click();
  await file('config.txt').click();
  await preview().getByText('new config').waitFor();
  await preview().locator('summary').click();
  const versions = preview().locator('.artifact-version-list li');
  await versions.first().waitFor();
  assert.equal(await versions.count(), 1, 'only the older config is an earlier version');
  await versions.first().getByRole('button').click();
  await preview().getByText('old config').waitFor();
  await preview().getByText('以前の版を表示しています').waitFor();
  await screenshot('artifact-previous-version');
  await preview().getByRole('button', { name: '最新の版に戻る' }).click();
  await preview().getByText('new config').waitFor();
  assert.equal(await file('config.txt').count(), 1, 'the latest list shows one row per path');
  assert.equal(latestConfig.path, 'config.txt');
  // An upload reloads the open folder.
  await page.getByRole('button', { name: 'Artifactをアップロード' }).click();
  await page.getByLabel('ファイル', { exact: true }).setInputFiles({
    name: 'uploaded.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('uploaded from the browser'),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'アップロード', exact: true }).click();
  await file('uploaded.txt').waitFor();

  console.log('Browser check: Project-wide search and the link to the Run');
  await page.goto(`${projectBase}/artifacts`);
  await page.getByRole('link', { name: 'Artifacts' }).first().waitFor();
  await page.getByRole('button', { name: 'predictions/notes.txt' }).waitFor();
  await page.getByLabel('保存パスで検索').fill('notes');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.waitForURL(/query=notes/);
  const rows = page.locator('.artifact-catalog tbody tr');
  await page.waitForFunction(() => document.querySelectorAll('.artifact-catalog tbody tr').length === 2);
  assert.deepEqual(
    (await rows.locator('td:first-child').allInnerTexts()).sort(),
    ['eval/notes.txt', 'predictions/notes.txt'],
  );
  await page.getByRole('button', { name: 'predictions/notes.txt' }).click();
  await preview().getByText('second run notes').waitFor();
  await screenshot('artifact-catalog-search');
  await rows.filter({ hasText: 'predictions/notes.txt' }).getByRole('link', { name: secondRun.name }).click();
  await page.waitForURL(new RegExp(`/runs/${secondRun.id}\\?tab=artifacts`));
  await folder('predictions').waitFor();

  console.log('Browser check: the first page of a Run with 10,000 files');
  artifactListRequests.length = 0;
  const started = Date.now();
  await page.goto(`${projectBase}/runs/${largeRun.id}?tab=artifacts`);
  await folder('clips').waitFor();
  await page.getByText('10,000件').waitFor();
  await folder('clips').click();
  await file('clips/00000.txt').waitFor();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < FIRST_PAGE_BUDGET_MS, `first page took ${elapsed}ms`);
  const fileRows = page.locator('.artifact-tree tbody tr');
  assert.equal(await fileRows.count(), RUN_ARTIFACT_PAGE_SIZE);
  // Folder pages and the preview's version lookup are bounded; nothing lists the whole Run.
  assert.ok(
    artifactListRequests.every((request) => /[?&]limit=\d+/.test(request)),
    `every list request is one page: ${artifactListRequests.join(', ')}`,
  );
  await page.getByRole('button', { name: '続きを読み込む' }).click();
  await file(`clips/${String(RUN_ARTIFACT_PAGE_SIZE).padStart(5, '0')}.txt`).waitFor();
  assert.equal(await fileRows.count(), RUN_ARTIFACT_PAGE_SIZE * 2);
  await screenshot('artifact-large-run');

  assert.deepEqual(pageErrors, []);
  console.log('Browser artifact browser check passed');
} finally {
  await browser.close();
}
