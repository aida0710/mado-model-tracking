/** Read every screen from the real API, compare runs and seek a generated audio Artifact. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('MMT_PLAYWRIGHT_MODULE is required');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
});
const verificationDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const artifactsDirectory = `artifacts/verification/${verificationDate}`;
await mkdir(artifactsDirectory, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
try {
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill('admin@localhost');
  await page.getByLabel('表示名').fill('開発管理者');
  await page.getByRole('button', { name: '開発モードでログイン', exact: true }).click();
  await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor();
  await page
    .getByLabel('プロジェクト', { exact: true })
    .selectOption({ label: 'Mado Model Tracking Demo' });
  await page.getByRole('link', { name: 'CPU linear regression', exact: true }).waitFor();
  const demoBase = new URL(page.url()).pathname.replace(/\/experiments.*/, '');
  for (const [route, heading] of [
    ['models', 'Models'],
    ['codes', 'Code'],
    ['datasets', 'Datasets'],
    ['lineage', 'Lineage'],
    ['jobs', 'Jobs'],
    ['compute', 'Compute'],
    ['plugins', 'Plugins'],
    ['settings', 'Settings'],
  ]) {
    await page.goto(`${base}${demoBase}/${route}`);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    await page.getByText('読み込み中…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('alert').count(), 0, `${route} returned an API error`);
  }
  await page.goto(`${base}${demoBase}/experiments`);
  await page.getByLabel('Runを選択: CPU linear regression').check();
  await page.getByLabel('Runを選択: Generated audio sample').check();
  await page.getByRole('button', { name: '比較', exact: true }).click();
  await page.getByRole('heading', { name: '比較', exact: true }).waitFor();
  await page.getByRole('link', { name: 'CPU linear regression', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Generated audio sample', exact: true }).click();
  await page.getByRole('heading', { name: 'Generated audio sample', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  const audio = page.locator('audio');
  await audio.waitFor();
  await audio.evaluate(
    (element) =>
      new Promise((resolve, reject) => {
        if (element.readyState >= 1) return resolve();
        element.addEventListener('loadedmetadata', () => resolve(), { once: true });
        element.addEventListener('error', () => reject(new Error('Audio metadata failed')), {
          once: true,
        });
      }),
  );
  const duration = await audio.evaluate((element) => element.duration);
  assert(Math.abs(duration - 1) < 0.01);
  const audioUrl = await audio.getAttribute('src');
  const range = await page.request.get(new URL(audioUrl, base).href, {
    headers: { Range: 'bytes=0-43' },
  });
  assert.equal(range.status(), 206);
  assert.equal((await range.body()).length, 44);

  const worker = JSON.parse(
    await readFile(`${artifactsDirectory}/worker-integration.json`, 'utf8'),
  );
  const projectLabel = await page
    .getByLabel('プロジェクト', { exact: true })
    .locator(`option[value="${worker.projectId}"]`)
    .innerText();
  await page.getByLabel('プロジェクト', { exact: true }).selectOption({ label: projectLabel });
  const workerBase = `/projects/${worker.projectId}`;
  await page.goto(`${base}${workerBase}/runs/${worker.trainingRunId}`);
  await page.getByRole('heading', { name: 'Real CPU training', exact: true }).waitFor();
  await page.getByRole('application').waitFor();
  await page.screenshot({ path: `${artifactsDirectory}/worker-training.png`, fullPage: true });
  await page.goto(`${base}${workerBase}/lineage`);
  await page.getByRole('heading', { name: 'Lineage', exact: true }).waitFor();
  await page.getByRole('group', { name: 'Lineage', exact: true }).waitFor();
  await page.screenshot({ path: `${artifactsDirectory}/worker-lineage.png`, fullPage: true });
  await page.goto(`${base}${workerBase}/experiments`);
  await page.getByRole('link', { name: 'Real CPU training', exact: true }).waitFor();
  await page.screenshot({ path: `${artifactsDirectory}/worker-runs.png`, fullPage: true });
  await page.getByRole('button', { name: 'ダークテーマ', exact: true }).click();
  await page.screenshot({ path: `${artifactsDirectory}/worker-runs-dark.png`, fullPage: true });
  assert.deepEqual(pageErrors, []);
  const summary = {
    checks: [
      'real API login and project switch',
      'all registered pages without API errors',
      'Run comparison',
      'audio preview and HTTP Range seek',
      'worker training and lineage display',
      'light/dark theme',
    ],
    pageErrors,
  };
  await writeFile(
    `${artifactsDirectory}/browser-integration.json`,
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
