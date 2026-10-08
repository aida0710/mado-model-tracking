// Browser check for step media: the step slider, the Run × step comparison with A/B playback, and
// media tables. The components are rendered by tests/fixtures/media/harness.html (served by the
// Vite dev server) against an API mocked here from the contract in packages/contracts/src/runMedia.ts.
// Fixtures in tests/fixtures/media/ were generated with ffmpeg:
//   ffmpeg -f lavfi -i "sine=frequency=<f>:sample_rate=16000:duration=2" -ac 1 -c:a pcm_s16le run-<a|b>-step-<n>.wav
//     (Run a: 300/600/900 Hz, Run b: 450/750/1050 Hz for steps 0/1/2)
//   ffmpeg -f lavfi -i "color=c=<red|green|blue>:s=64x48:d=1" -frames:v 1 sample-step-<n>.png
//   ffmpeg -f lavfi -i "color=c=gray:s=32x24:d=1" -frames:v 1 sample-thumbnail.png
// mlflow-table.json is MLflow log_table's split format with an audio column added.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  // Switch checks press play from scripts, not from a user gesture.
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
const fixtureDirectory = new URL('./fixtures/media/', import.meta.url);
const readFixture = (name) => readFile(new URL(name, fixtureDirectory));
// The table has more rows than one page (50) so paging is exercised.
const TABLE_ROW_COUNT = 60;

const projectId = '00000000-0000-4000-8000-000000000001';
const otherProjectId = '99999999-9999-4999-8999-999999999999';
const runA = { id: '00000000-0000-4000-8000-0000000000a1', name: 'run-a（lr=1e-3）' };
const runB = { id: '00000000-0000-4000-8000-0000000000b1', name: 'run-b（lr=3e-4）' };
let sequence = 1000;
const identifier = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;

const artifacts = new Map();
function addArtifact({ run, path, mimeType, body }) {
  const artifact = { id: identifier(), projectId, runId: run.id, path, mimeType, size: body.length, body };
  artifacts.set(artifact.id, artifact);
  return artifact;
}
const media = [];
function addMedia({ run, key, step, kind, artifact, thumbnail = null, caption = null, source = 'native' }) {
  const item = {
    id: identifier(),
    runId: run.id,
    key,
    step,
    kind,
    artifactId: artifact.id,
    thumbnailArtifactId: thumbnail?.id ?? null,
    caption,
    metadata: {},
    source,
    path: artifact.path,
    mimeType: artifact.mimeType,
    size: artifact.size,
    contentUrl: `/api/projects/${projectId}/artifacts/${artifact.id}/content`,
    thumbnailContentUrl: thumbnail ? `/api/projects/${projectId}/artifacts/${thumbnail.id}/content` : null,
    ...(kind === 'audio'
      ? { mediaInfo: { artifactId: artifact.id, durationSeconds: 2, sampleRate: 16000, channels: 1, bitsPerSample: 16, codec: 'pcm_s16le', source: 'header' } }
      : {}),
    createdAt: '2026-10-08T00:00:00Z',
  };
  media.push(item);
  return item;
}

const audioByRunStep = new Map();
for (const [run, letter] of [
  [runA, 'a'],
  [runB, 'b'],
])
  for (const step of [0, 1, 2]) {
    const artifact = addArtifact({
      run,
      path: `audio/run-${letter}-step-${step}.wav`,
      mimeType: 'audio/wav',
      body: await readFixture(`run-${letter}-step-${step}.wav`),
    });
    audioByRunStep.set(`${letter}:${step}`, artifact);
    addMedia({ run, key: 'eval/audio', step, kind: 'audio', artifact, caption: `Run ${letter} の step ${step}` });
  }
// Run a also logged step 3, so the default comparison (latest step of each Run) has a missing cell.
const runAStep3 = addArtifact({ run: runA, path: 'audio/run-a-step-3.wav', mimeType: 'audio/wav', body: await readFixture('run-a-step-2.wav') });
addMedia({ run: runA, key: 'eval/audio', step: 3, kind: 'audio', artifact: runAStep3 });

const thumbnail = addArtifact({ run: runA, path: 'table_images/thumbnail.png', mimeType: 'image/png', body: await readFixture('sample-thumbnail.png') });
const imageByStep = [];
for (const step of [0, 1, 2]) {
  const body = await readFixture(`sample-step-${step}.png`);
  const logged = addArtifact({ run: runA, path: `images/samples+step+${step}+timestamp+1+uuid.png`, mimeType: 'image/png', body });
  imageByStep.push(logged);
  addMedia({ run: runA, key: 'samples', step, kind: 'image', artifact: logged, source: 'mlflow' });
  addArtifact({ run: runA, path: `table_images/step-${step}.png`, mimeType: 'image/png', body });
}
const tableSource = JSON.parse((await readFixture('mlflow-table.json')).toString('utf8').replaceAll('RUN_B_ID', runB.id));
const tableArtifact = addArtifact({ run: runA, path: 'eval_table.json', mimeType: 'application/json', body: Buffer.from(JSON.stringify(tableSource)) });
const tableMedia = addMedia({ run: runA, key: 'eval_table.json', step: 0, kind: 'table', artifact: tableArtifact, source: 'mlflow' });

// What the API does for /table: column types from the values, media cells resolved to Artifacts.
const TABLE_COLUMN_TYPES = { caption: 'text', image: 'image', audio: 'audio', score: 'number', meta: 'json' };
function findArtifact(runId, path) {
  return [...artifacts.values()].find((artifact) => artifact.runId === runId && artifact.path === path);
}
function resolveCell(type, value) {
  if (value === null) return null;
  const written = typeof value === 'string' ? value : value.filepath;
  let runId = runA.id;
  let path = written;
  if (written.startsWith('mmt-artifact://')) {
    const segments = written.slice('mmt-artifact://'.length).split('/');
    if (segments[0] === 'projects') {
      if (segments[1] !== projectId) return { type, runId: null, path: written, artifactId: null, thumbnailArtifactId: null, error: 'other_project' };
      segments.splice(0, 2);
    }
    runId = segments[1];
    path = segments.slice(2).join('/');
  }
  const artifact = findArtifact(runId, path);
  if (!artifact) return { type, runId, path, artifactId: null, thumbnailArtifactId: null, error: 'not_found' };
  const compressed = typeof value === 'object' && value.compressed_filepath ? findArtifact(runA.id, value.compressed_filepath) : null;
  return { type, runId, path, artifactId: artifact.id, thumbnailArtifactId: compressed?.id ?? null, error: null };
}
const tableRows = Array.from({ length: TABLE_ROW_COUNT }, (_, index) => {
  const row = tableSource.data[index % tableSource.data.length];
  return tableSource.columns.map((name, column) => {
    const type = TABLE_COLUMN_TYPES[name];
    return type === 'image' || type === 'audio' ? resolveCell(type, row[column]) : row[column];
  });
});

function keySummaries(runId) {
  const summaries = new Map();
  for (const item of media.filter((entry) => entry.runId === runId)) {
    const summary = summaries.get(item.key) ?? { key: item.key, kind: item.kind, count: 0, minStep: item.step, maxStep: item.step };
    summary.count += 1;
    summary.minStep = Math.min(summary.minStep, item.step);
    summary.maxStep = Math.max(summary.maxStep, item.step);
    summaries.set(item.key, summary);
  }
  return [...summaries.values()].sort((left, right) => left.key.localeCompare(right.key));
}
function compareGrid({ runIds, key, steps }) {
  const ofKey = media.filter((item) => item.key === key && runIds.includes(item.runId));
  const cellAt = (runId, step) => {
    const items = ofKey.filter((item) => item.runId === runId && item.step === step);
    return items.length > 0 ? items : null;
  };
  // Without steps each row has one cell, its Run's latest step. Missing cells stay null.
  return {
    key,
    steps: steps ?? null,
    rows: runIds.map((runId) => {
      if (steps) return { runId, cells: steps.map((step) => cellAt(runId, step)) };
      const latest = Math.max(...ofKey.filter((item) => item.runId === runId).map((item) => item.step));
      return { runId, cells: [Number.isFinite(latest) ? cellAt(runId, latest) : null] };
    }),
  };
}

const apiRequests = [];
const contentRequests = [];
await context.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api'.length);
    apiRequests.push({ method: request.method(), path });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const projectPrefix = `/projects/${projectId}`;
    if (!path.startsWith(projectPrefix)) return json({ error: 'not found', code: 'not_found' }, 404);
    const rest = path.slice(projectPrefix.length);
    let match;
    if ((match = rest.match(/^\/artifacts\/([^/]+)\/content$/))) {
      const artifact = artifacts.get(match[1]);
      if (!artifact) return json({ error: 'not found', code: 'not_found' }, 404);
      contentRequests.push({ artifactId: artifact.id, resourceType: request.resourceType() });
      const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      if (!range)
        return route.fulfill({ status: 200, contentType: artifact.mimeType, headers: { 'Accept-Ranges': 'bytes' }, body: artifact.body });
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), artifact.body.length - 1) : artifact.body.length - 1;
      return route.fulfill({
        status: 206,
        contentType: artifact.mimeType,
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${artifact.body.length}` },
        body: artifact.body.subarray(start, end + 1),
      });
    }
    if ((match = rest.match(/^\/artifacts\/([^/]+)\/media-info$/))) return json({ error: 'none', code: 'not_found' }, 404);
    if ((match = rest.match(/^\/artifacts\/([^/]+)\/previews$/))) return json({ items: [] });
    if ((match = rest.match(/^\/runs\/([^/]+)$/))) {
      const run = [runA, runB].find((candidate) => candidate.id === match[1]);
      return run ? json({ ...run, projectId, status: 'finished' }) : json({ error: 'not found', code: 'not_found' }, 404);
    }
    if ((match = rest.match(/^\/runs\/([^/]+)\/media\/keys$/))) return json({ items: keySummaries(match[1]) });
    if ((match = rest.match(/^\/runs\/([^/]+)\/media\/([^/]+)\/table$/))) {
      if (decodeURIComponent(match[2]) !== tableMedia.id) return json({ error: 'not found', code: 'not_found' }, 404);
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return json({
        columns: tableSource.columns.map((name) => ({ name, type: TABLE_COLUMN_TYPES[name] })),
        rows: tableRows.slice(offset, offset + limit),
        totalRows: tableRows.length,
        offset,
      });
    }
    if ((match = rest.match(/^\/runs\/([^/]+)\/media$/))) {
      const key = url.searchParams.get('key');
      const items = media.filter((item) => item.runId === match[1] && item.key === key).sort((left, right) => left.step - right.step);
      return json({ items });
    }
    if (rest === '/media/compare' && request.method() === 'POST') return json(compareGrid(request.postDataJSON()));
    return json({ error: 'not found', code: 'not_found' }, 404);
  },
);

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const harness = (parameters) =>
  `${base}/tests/fixtures/media/harness.html?${new URLSearchParams({ projectId, ...parameters })}`;
const contentUrl = (artifact) => `/api/projects/${projectId}/artifacts/${artifact.id}/content`;

async function screenshot(name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
}
async function waitUntil(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await page.waitForTimeout(50);
  }
  throw new Error(message);
}
const audioStates = () =>
  page.locator('audio').evaluateAll((items) => items.map((audio) => ({ src: audio.getAttribute('src'), currentTime: audio.currentTime, paused: audio.paused })));
const playingAudio = async () => (await audioStates()).filter((audio) => !audio.paused);

try {
  console.log('Browser check: the step slider moves between recorded steps and changes the audio');
  await page.goto(harness({ view: 'panel', runId: runA.id }));
  // The first key ('eval_table.json' sorts before 'eval/audio') opens first; choose the audio key.
  await page.getByRole('button', { name: 'eval/audio', exact: true }).click();
  const slider = page.getByRole('slider', { name: '表示するstep' });
  // The latest step is shown first.
  await page.locator('.media-step-value', { hasText: 'step 3（4 / 4）' }).waitFor();
  await page.locator(`.run-media-step audio[src="${contentUrl(runAStep3)}"]`).waitFor();
  await page.locator('.media-info', { hasText: '16,000 Hz' }).waitFor();
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await page.locator('.media-step-value', { hasText: 'step 2（3 / 4）' }).waitFor();
  const step2 = audioByRunStep.get('a:2');
  await page.locator(`.run-media-step audio[src="${contentUrl(step2)}"]`).waitFor();
  await page.locator('.media-caption', { hasText: 'Run a の step 2' }).waitFor();
  await page.locator('.run-media-step .audio-viewer canvas.audio-spectrogram').waitFor();
  await screenshot('run-media-audio-light');

  console.log('Browser check: moving the step stops the previous audio');
  await page.locator('.run-media-step').getByRole('button', { name: '再生', exact: true }).click();
  await waitUntil(async () => (await playingAudio()).length === 1, 'step 2 audio did not start');
  await page.getByRole('button', { name: '前のstep' }).click();
  await page.locator('.media-step-value', { hasText: 'step 1（2 / 4）' }).waitFor();
  await page.locator(`.run-media-step audio[src="${contentUrl(audioByRunStep.get('a:1'))}"]`).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(await playingAudio(), [], 'audio kept playing after the step moved');
  await slider.focus();
  await page.keyboard.press('Home');
  await page.locator('.media-step-value', { hasText: 'step 0（1 / 4）' }).waitFor();

  console.log('Browser check: the image key keeps the nearest recorded step and changes the image');
  await slider.focus();
  await page.keyboard.press('End');
  await page.locator('.media-step-value', { hasText: 'step 3（4 / 4）' }).waitFor();
  await page.getByRole('button', { name: 'samples', exact: true }).click();
  // samples has steps 0–2, so step 3 snaps to 2.
  await page.locator('.media-step-value', { hasText: 'step 2（3 / 3）' }).waitFor();
  await page.locator(`.media-image img[src="${contentUrl(imageByStep[2])}"]`).waitFor();
  await slider.focus();
  await page.keyboard.press('Home');
  await page.locator(`.media-image img[src="${contentUrl(imageByStep[0])}"]`).waitFor();
  assert.equal(await page.locator(`.media-image img[src="${contentUrl(imageByStep[2])}"]`).count(), 0);
  await screenshot('run-media-image-light');

  console.log('Browser check: an MLflow table with image and audio cells');
  await page.getByRole('button', { name: 'eval_table.json', exact: true }).click();
  const table = page.locator('.media-table');
  await table.getByText(`${TABLE_ROW_COUNT}行`).waitFor();
  assert.equal(await table.locator('tbody > tr').count(), 50);
  // Every 4 rows hold one other-Project reference and one missing file: 12 + 12 in the first 50.
  await table.getByText('表示できないセル 24件').waitFor();
  await table.getByText('別のプロジェクトのArtifactは参照できません').first().waitFor();
  await table.getByText('Artifactが見つかりません').first().waitFor();
  assert.ok(await table.locator('audio').evaluateAll((items) => items.length > 0 && items.every((audio) => audio.preload === 'none')));
  const contentBeforePlay = contentRequests.filter((entry) => entry.resourceType === 'media').length;
  await page.waitForTimeout(300);
  assert.equal(contentRequests.filter((entry) => entry.resourceType === 'media').length, contentBeforePlay, 'table audio loaded before play');
  // The first image cell shows the MLflow compressed thumbnail; opening it shows the full image.
  const firstRow = table.locator('tbody > tr').first();
  await firstRow.locator(`.media-thumbnail-button img[src="${contentUrl(thumbnail)}"]`).waitFor();
  await firstRow.locator('.media-thumbnail-button').click();
  await firstRow.locator(`.media-cell-detail img.artifact-image[src="${contentUrl(findArtifact(runA.id, 'table_images/step-0.png'))}"]`).waitFor();
  await firstRow.getByRole('button', { name: '再生', exact: true }).click();
  await waitUntil(async () => (await playingAudio()).length === 1, 'table audio did not play');
  // Another row's audio stops the first one: one table audio at a time.
  const secondRow = table.locator('tbody > tr').nth(1);
  await secondRow.getByRole('button', { name: '再生', exact: true }).click();
  await waitUntil(async () => {
    const playing = await playingAudio();
    return playing.length === 1 && playing[0].src === contentUrl(audioByRunStep.get('b:1'));
  }, 'second row did not take over playback');
  await secondRow.getByRole('button', { name: '一時停止' }).click();
  await secondRow.getByRole('button', { name: '波形' }).click();
  await secondRow.locator('.media-cell-detail canvas.audio-spectrogram').waitFor();
  await screenshot('run-media-table-light');
  await table.getByRole('button', { name: '次のページ' }).click();
  await table.getByText('2 / 2ページ').waitFor();
  assert.equal(await table.locator('tbody > tr').count(), TABLE_ROW_COUNT - 50);

  console.log('Browser check: the default comparison shows each Run latest step and missing cells as なし');
  await page.goto(harness({ view: 'compare', runIds: `${runA.id},${runB.id}` }));
  const grid = page.getByRole('grid', { name: 'Run × step のメディア' });
  await grid.waitFor();
  await page.getByLabel('比較するキー').selectOption('eval/audio');
  await waitUntil(async () => (await grid.locator('thead th').allInnerTexts()).join('|') === 'Run|step 2|step 3', 'grid did not show the latest steps');
  await grid.getByRole('button', { name: `${runB.name}、step 3、なし` }).waitFor();
  await grid.getByRole('button', { name: `${runB.name}、step 2、音声` }).waitFor();

  console.log('Browser check: 2 Runs × 3 steps, switching cells continues from the same position');
  await page.getByLabel('比較するstep').fill('0, 1, 2');
  await page.getByRole('button', { name: '表示', exact: true }).click();
  await waitUntil(async () => (await grid.locator('thead th').allInnerTexts()).join('|') === 'Run|step 0|step 1|step 2', 'grid did not show steps 0–2');
  assert.equal(await grid.locator('.media-compare-cell.missing').count(), 0);
  await grid.getByRole('button', { name: `${runA.name}、step 1、音声` }).click();
  const detail = page.locator('.media-compare-detail');
  await detail.locator(`audio[src="${contentUrl(audioByRunStep.get('a:1'))}"]`).waitFor();
  await detail.locator('canvas.audio-spectrogram').waitFor();
  await detail.getByRole('button', { name: '再生', exact: true }).click();
  await page.waitForTimeout(700);
  const before = (await playingAudio())[0];
  assert.ok(before && before.src === contentUrl(audioByRunStep.get('a:1')), 'Run a step 1 is not playing');
  // The play button took focus; arrow keys move within the grid once a cell has focus again.
  await grid.getByRole('button', { name: `${runA.name}、step 1、音声` }).focus();
  await page.keyboard.press('ArrowDown');
  await waitUntil(async () => {
    const playing = await playingAudio();
    return playing.length === 1 && playing[0].src === contentUrl(audioByRunStep.get('b:1'));
  }, 'ArrowDown did not switch to Run b step 1');
  const after = (await playingAudio())[0];
  assert.ok(after.currentTime >= before.currentTime - 0.05, `position went back: ${before.currentTime} -> ${after.currentTime}`);
  assert.ok(after.currentTime - before.currentTime < 0.6, `position jumped: ${before.currentTime} -> ${after.currentTime}`);
  await page.keyboard.press('ArrowRight');
  await waitUntil(async () => {
    const playing = await playingAudio();
    return playing.length === 1 && playing[0].src === contentUrl(audioByRunStep.get('b:2'));
  }, 'ArrowRight did not switch to Run b step 2');
  assert.equal((await audioStates()).length, 1, 'more than one player is mounted');
  await detail.getByRole('button', { name: '一時停止' }).click();
  await waitUntil(async () => (await playingAudio()).length === 0, 'pause did not stop the compared audio');
  await screenshot('media-compare-light');

  console.log('Browser check: a viewer only reads');
  assert.deepEqual(
    [...new Set(apiRequests.filter((entry) => entry.method !== 'GET').map((entry) => `${entry.method} ${entry.path}`))],
    [`POST /projects/${projectId}/media/compare`],
  );

  console.log('Browser check: dark theme screenshots');
  await page.goto(harness({ view: 'compare', runIds: `${runA.id},${runB.id}`, theme: 'dark' }));
  await page.getByRole('grid', { name: 'Run × step のメディア' }).waitFor();
  await page.getByLabel('比較するキー').selectOption('eval/audio');
  await page.locator('.media-compare-detail canvas.audio-spectrogram').waitFor();
  await screenshot('media-compare-dark');
  await page.goto(harness({ view: 'panel', runId: runA.id, theme: 'dark' }));
  await page.getByRole('button', { name: 'eval/audio', exact: true }).click();
  await page.locator('.run-media-step .audio-viewer canvas.audio-spectrogram').waitFor();
  await screenshot('run-media-audio-dark');

  assert.deepEqual(pageErrors, []);
  console.log('Browser media check passed');
} catch (error) {
  await screenshot('failure');
  throw error;
} finally {
  await browser.close();
}
