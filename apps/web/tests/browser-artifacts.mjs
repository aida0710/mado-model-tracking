// Browser check for the audio viewer, evaluation sample tables, and Artifact comparison.
// Fixtures in tests/fixtures/audio/ were generated with ffmpeg:
//   ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=16000:duration=2" -ac 1 -c:a pcm_s16le mono-16k.wav
//   ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2" \
//     -f lavfi -i "sine=frequency=1760:sample_rate=48000:duration=2" \
//     -filter_complex "[0][1]amerge=inputs=2" -ac 2 -c:a flac stereo-48k.flac
//   ffmpeg -f lavfi -i "sine=frequency=660:sample_rate=22050:duration=2" -ac 1 -c:a libmp3lame -b:a 64k tone-22k.mp3
//   ffmpeg -f lavfi -i "aevalsrc=0.6*sin(2*PI*(150+900*t)*t)*(0.6+0.4*sin(2*PI*3*t)):s=16000:d=2" \
//     -ac 1 -c:a pcm_s16le chirp-16k.wav
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  // Loop and switch checks press play from scripts, not from a user gesture.
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
const fixtureDirectory = new URL('./fixtures/audio/', import.meta.url);
const fixtures = {
  wav: await readFile(new URL('mono-16k.wav', fixtureDirectory)),
  flac: await readFile(new URL('stereo-48k.flac', fixtureDirectory)),
  mp3: await readFile(new URL('tone-22k.mp3', fixtureDirectory)),
  // A rising tone makes the screenshots show a readable spectrogram.
  chirp: await readFile(new URL('chirp-16k.wav', fixtureDirectory)),
};
// The viewer decides from Artifact.size, so a small body with a large declared size exercises the limit.
const OVER_ANALYSIS_LIMIT_BYTES = 64 * 1024 * 1024 + 1;
const EVALUATION_ROW_COUNT = 120;

const api = createBrowserApi();
api.state.loggedIn = true;
const [firstRun, secondRun] = api.state.runs;
const projectId = api.state.project.id;
const otherProjectId = '99999999-9999-4999-8999-999999999999';
let sequence = 7000;
const identifier = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const contents = new Map();
const controls = { brokenServesValid: false };
function addArtifact({ run, path, mimeType, body, size }) {
  const artifact = {
    id: identifier(),
    projectId,
    runId: run.id,
    path,
    backend: 'filesystem',
    storageKey: path,
    mimeType,
    size: size ?? body.length,
    sha256: '0'.repeat(64),
    createdAt: '2026-10-08T00:00:00Z',
  };
  api.state.artifacts.push(artifact);
  contents.set(artifact.id, { artifact, body });
  return artifact;
}
const wav = addArtifact({ run: firstRun, path: 'audio/mono-16k.wav', mimeType: 'audio/wav', body: fixtures.wav });
addArtifact({ run: firstRun, path: 'audio/stereo-48k.flac', mimeType: 'audio/flac', body: fixtures.flac });
addArtifact({ run: firstRun, path: 'audio/tone-22k.mp3', mimeType: 'audio/mpeg', body: fixtures.mp3 });
const large = addArtifact({
  run: firstRun,
  path: 'audio/large.wav',
  mimeType: 'audio/wav',
  body: fixtures.wav,
  size: OVER_ANALYSIS_LIMIT_BYTES,
});
const broken = addArtifact({
  run: firstRun,
  path: 'audio/broken.wav',
  mimeType: 'audio/wav',
  body: Buffer.from('this is not audio data at all'),
});
addArtifact({ run: firstRun, path: 'shared/sample.wav', mimeType: 'audio/wav', body: fixtures.chirp });
addArtifact({ run: secondRun, path: 'shared/sample.wav', mimeType: 'audio/flac', body: fixtures.flac });
addArtifact({ run: secondRun, path: 'eval/a.wav', mimeType: 'audio/wav', body: fixtures.chirp });
const evaluationRows = [
  { audio: 'eval/a.wav', reference: '今日は晴れです', prediction: '今日は雨です', score: 0.4 },
  { audio: `mmt-artifact://runs/${firstRun.id}/audio/mono-16k.wav`, reference: 'こんにちは', prediction: 'こんにちは', score: 0 },
  { audio: 'eval/missing.wav', reference: 'あ', prediction: 'い', score: 1 },
  { audio: `mmt-artifact://projects/${otherProjectId}/runs/${firstRun.id}/a.wav`, reference: 'x', prediction: 'x', score: 0.9 },
].map((row) => JSON.stringify(row));
evaluationRows.push('{"audio": "eval/a.wav", "reference": "壊れた行"');
for (let index = evaluationRows.length; index < EVALUATION_ROW_COUNT + 1; index += 1)
  evaluationRows.push(JSON.stringify({ audio: 'eval/a.wav', reference: `文${index}`, prediction: `文${index}`, score: index / 1000 }));
const evaluationTable = addArtifact({
  run: secondRun,
  path: 'eval/results.jsonl',
  mimeType: 'application/x-ndjson',
  body: Buffer.from(evaluationRows.join('\n')),
});

const contentRequests = [];
await context.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/artifacts\/([^/]+)\/content$/);
    const entry = match && contents.get(match[1]);
    if (!entry) return api.route(route);
    contentRequests.push({ artifactId: entry.artifact.id, resourceType: route.request().resourceType() });
    const body = entry.artifact.id === broken.id && controls.brokenServesValid ? fixtures.wav : entry.body;
    // Media elements only seek within ranges the server can serve, as the real API does (206).
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range)
      return route.fulfill({ status: 200, contentType: entry.artifact.mimeType, headers: { 'Accept-Ranges': 'bytes' }, body });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({
      status: 206,
      contentType: entry.artifact.mimeType,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
    });
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
async function setTheme(theme) {
  await page.evaluate((value) => localStorage.setItem('mmt.theme', value), theme);
  await page.reload();
}
async function openArtifact(path) {
  await page.getByRole('button', { name: path, exact: true }).click();
  await page.locator('.artifact-preview h3', { hasText: path }).waitFor();
}
const viewer = () => page.locator('.artifact-preview .audio-viewer').first();
const audioState = (locator) =>
  locator.locator('audio').evaluate((audio) => ({ currentTime: audio.currentTime, paused: audio.paused }));
/** Spectrogram row with the most energy in the middle frame, counted from the bottom (= bin index). */
const loudestSpectrogramBin = (locator) =>
  locator.locator('canvas.audio-spectrogram').evaluate((canvas) => {
    const context = canvas.getContext('2d');
    const column = Math.floor(canvas.width / 2);
    const pixels = context.getImageData(column, 0, 1, canvas.height).data;
    let best = 0;
    let bestValue = -1;
    for (let row = 0; row < canvas.height; row += 1) {
      const value = pixels[row * 4] + pixels[row * 4 + 1] + pixels[row * 4 + 2];
      if (value > bestValue) [best, bestValue] = [row, value];
    }
    return { bin: canvas.height - 1 - best, binCount: canvas.height };
  });
async function waitForAnalysis(locator) {
  await locator.locator('canvas.audio-waveform').waitFor();
  await locator.locator('canvas.audio-spectrogram').waitFor();
  await locator.locator('.audio-meta').waitFor();
}
async function waitUntil(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await page.waitForTimeout(50);
  }
  throw new Error(message);
}

try {
  console.log('Browser check: WAV mono 16kHz waveform, spectrogram, seek, loop');
  await page.goto(`${projectBase}/runs/${firstRun.id}?tab=artifacts`);
  await openArtifact(wav.path);
  await waitForAnalysis(viewer());
  await viewer().locator('.audio-meta', { hasText: '16,000 Hz' }).waitFor();
  assert.match(await viewer().locator('.audio-meta').innerText(), /チャンネル数\s+1/);
  const wavBin = await loudestSpectrogramBin(viewer());
  assert.equal(wavBin.binCount, 513);
  assert.ok(Math.abs(wavBin.bin - Math.round((440 * 1024) / 16000)) <= 1, `440Hz bin ${wavBin.bin}`);
  await screenshot('audio-viewer-light');

  const timeline = viewer().locator('.audio-timeline');
  const box = await timeline.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await waitUntil(async () => Math.abs((await audioState(viewer())).currentTime - 1) < 0.05, 'click did not seek to 1.0s');
  await page.mouse.move(box.x + box.width * 0.25, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + 20, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.5, box.y + 20, { steps: 4 });
  await page.mouse.up();
  await viewer().locator('.audio-loop-label', { hasText: '0:00.50–0:01.00' }).waitFor();
  await viewer().getByRole('button', { name: '再生', exact: true }).click();
  // 1.5s of playback crosses the loop end at least twice; the position must stay inside the loop.
  const loopDeadline = Date.now() + 1500;
  while (Date.now() < loopDeadline) {
    const { currentTime, paused } = await audioState(viewer());
    assert.equal(paused, false);
    assert.ok(currentTime >= 0.49 && currentTime <= 1.1, `loop escaped: ${currentTime}`);
    await page.waitForTimeout(100);
  }
  await viewer().getByRole('button', { name: '一時停止' }).click();
  await viewer().getByRole('button', { name: 'ループを解除' }).click();
  await viewer().getByRole('button', { name: '拡大' }).click();
  await viewer().getByRole('slider', { name: '表示位置' }).waitFor();
  await viewer().getByRole('button', { name: '全体を表示' }).click();

  console.log('Browser check: FLAC stereo 48kHz channel selection');
  await openArtifact('audio/stereo-48k.flac');
  await waitForAnalysis(viewer());
  await viewer().locator('.audio-meta', { hasText: '48,000 Hz' }).waitFor();
  assert.match(await viewer().locator('.audio-meta').innerText(), /チャンネル数\s+2/);
  await viewer().getByLabel('チャンネル').selectOption('0');
  await waitUntil(async () => Math.abs((await loudestSpectrogramBin(viewer())).bin - 9) <= 1, 'left channel is not 440Hz');
  await viewer().getByLabel('チャンネル').selectOption('1');
  await waitUntil(async () => Math.abs((await loudestSpectrogramBin(viewer())).bin - 38) <= 1, 'right channel is not 1760Hz');
  await viewer().getByLabel('スペクトログラム').selectOption('mel');
  await waitUntil(
    async () => (await loudestSpectrogramBin(viewer())).binCount === 80,
    'mel scale did not switch to 80 bands',
  );

  console.log('Browser check: MP3');
  await openArtifact('audio/tone-22k.mp3');
  await waitForAnalysis(viewer());
  await viewer().locator('.audio-meta', { hasText: '22,050 Hz' }).waitFor();

  console.log('Browser check: files over 64MiB are played without analysis');
  await openArtifact(large.path);
  await viewer().getByText('64MiBを超えるため').waitFor();
  assert.equal(await viewer().locator('canvas').count(), 0);
  assert.equal(await viewer().locator('audio').count(), 1);
  assert.equal(contentRequests.filter((item) => item.artifactId === large.id && item.resourceType === 'fetch').length, 0);

  console.log('Browser check: decode failure and retry');
  await openArtifact(broken.path);
  await viewer().getByText('音声をデコードできませんでした').waitFor();
  controls.brokenServesValid = true;
  await viewer().getByRole('button', { name: '再試行' }).first().click();
  await waitForAnalysis(viewer());

  console.log('Browser check: evaluation samples');
  await page.goto(`${projectBase}/runs/${secondRun.id}?tab=artifacts`);
  await openArtifact(evaluationTable.path);
  const samples = page.locator('.evaluation-samples');
  await samples.getByText(`${EVALUATION_ROW_COUNT}件のサンプル`).waitFor();
  // The Run's first Artifact (an audio file) is previewed before the table is chosen; count from here.
  const requestsBeforeTable = contentRequests.length;
  await samples.getByText('読み取れない行 1件').waitFor();
  assert.equal(await samples.locator('tbody > tr').count(), 50);
  await samples.locator('tbody audio').first().waitFor();
  const firstRow = samples.locator('tbody > tr').first();
  assert.equal(await firstRow.locator('mark.text-diff-delete').innerText(), '晴れ');
  assert.equal(await firstRow.locator('mark.text-diff-insert').innerText(), '雨');
  assert.equal(await samples.locator('tbody > tr').nth(1).locator('audio').count(), 1);
  await samples.getByText('Artifactが見つかりません').waitFor();
  await samples.getByText('別のプロジェクトのArtifactは参照できません').waitFor();
  assert.ok(
    await samples.locator('tbody audio').evaluateAll((items) => items.every((audio) => audio.preload === 'none')),
  );
  assert.equal(await samples.locator('canvas').count(), 0);
  await page.waitForTimeout(500);
  assert.deepEqual(contentRequests.slice(requestsBeforeTable), [], 'rows fetched audio before play');
  await screenshot('evaluation-samples-light');
  await firstRow.getByRole('button', { name: '波形' }).click();
  await waitForAnalysis(samples.locator('.evaluation-sample-detail .audio-viewer'));
  await samples.getByRole('button', { name: '次のページ' }).click();
  await samples.getByText('2 / 3ページ').waitFor();
  await samples.getByRole('button', { name: '次のページ' }).click();
  assert.equal(await samples.locator('tbody > tr').count(), EVALUATION_ROW_COUNT - 100);
  await samples.getByLabel('並び順').selectOption('score_desc');
  await samples.getByText('1 / 3ページ').waitFor();
  assert.equal(await samples.locator('tbody > tr').first().locator('td').nth(4).innerText(), '1');

  console.log('Browser check: comparing the same path across two Runs');
  await page.goto(`${projectBase}/compare?runs=${firstRun.id},${secondRun.id}&tab=artifacts`);
  await page.getByRole('button', { name: 'shared/sample.wav' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'audio/mono-16k.wav' }).count(), 0);
  const compared = page.locator('.artifact-compare-item');
  assert.equal(await compared.count(), 2);
  await waitForAnalysis(compared.nth(0));
  await waitForAnalysis(compared.nth(1));
  await compared.nth(0).getByRole('button', { name: '再生', exact: true }).click();
  await page.waitForTimeout(600);
  await compared.nth(1).getByRole('button', { name: '同じ位置から再生' }).click();
  await waitUntil(async () => (await audioState(compared.nth(0))).paused, 'first Run kept playing');
  const [firstState, secondState] = [await audioState(compared.nth(0)), await audioState(compared.nth(1))];
  assert.equal(secondState.paused, false);
  assert.ok(Math.abs(secondState.currentTime - firstState.currentTime) < 0.25, 'switch did not keep the position');
  await compared.nth(1).getByRole('button', { name: '一時停止' }).click();
  await screenshot('compare-artifacts-light');

  console.log('Browser check: dark theme screenshots');
  await setTheme('dark');
  await waitForAnalysis(compared.nth(1));
  await screenshot('compare-artifacts-dark');
  await page.goto(`${projectBase}/runs/${firstRun.id}?tab=artifacts`);
  await openArtifact(wav.path);
  await waitForAnalysis(viewer());
  await screenshot('audio-viewer-dark');
  await page.goto(`${projectBase}/runs/${secondRun.id}?tab=artifacts`);
  await openArtifact(evaluationTable.path);
  await page.locator('.evaluation-samples tbody audio').first().waitFor();
  await screenshot('evaluation-samples-dark');
  await setTheme('light');

  assert.deepEqual(pageErrors, []);
  console.log('Browser artifacts check passed');
} finally {
  await browser.close();
}
