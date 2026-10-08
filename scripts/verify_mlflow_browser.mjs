/** Verify official SDK records in the running dashboard and save review screenshots. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('MMT_PLAYWRIGHT_MODULE is required');
const { chromium } = await import(pathToFileURL(modulePath).href);
const verificationDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const artifactDirectory = `artifacts/verification/${verificationDate}/mlflow3`;
await mkdir(artifactDirectory, { recursive: true });
const verified = JSON.parse(
  await readFile(`${artifactDirectory}/sdk-3.17-integration.json`, 'utf8'),
);
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const projectBase = `/projects/${verified.projectId}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill('admin@localhost');
  await page.getByLabel('表示名').fill('開発管理者');
  await page.getByRole('button', { name: '開発モードでログイン', exact: true }).click();
  await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor();
  await page.getByLabel('プロジェクト', { exact: true }).selectOption(verified.projectId);

  await page.goto(`${base}${projectBase}/runs/${verified.tracking.runId}`);
  await page.getByRole('heading', { name: 'Official SDK training', exact: true }).waitFor();
  await page.getByRole('img', { name: 'Metrics: loss', exact: true }).waitFor();
  await page.getByRole('button', { name: 'ダークテーマ', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${artifactDirectory}/sdk-run-metrics.png` });
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  await page.getByText('learning_rate', { exact: true }).waitFor();
  await page.getByText('0.01', { exact: true }).waitFor();

  await page.goto(`${base}${projectBase}/runs/${verified.models.runId}?tab=artifacts`);
  await page
    .getByRole('button', {
      name: `models/${verified.models.loggedModelId}/MLmodel`,
      exact: true,
    })
    .waitFor();

  await page.goto(`${base}${projectBase}/runs/${verified.automation.runId}?tab=details`);
  await page.getByRole('heading', { name: 'Parameters', exact: true }).waitFor();
  await page.getByText('mlflow-registry', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  await page.getByRole('button', { name: 'evaluation/prediction.json', exact: true }).click();
  await page.getByText('"prediction"', { exact: false }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.screenshot({ path: `${artifactDirectory}/automatic-evaluation.png` });

  await page.goto(`${base}${projectBase}/models`);
  await page.getByText('linear-regression', { exact: true }).first().waitFor();
  await page.getByText('candidate', { exact: true }).first().waitFor();

  await page.goto(`${base}${projectBase}/lineage`);
  await page.getByRole('link', { name: 'MLflowモデル: linear-model', exact: true }).waitFor();
  assert.ok((await page.locator('.node-loggedModel').count()) >= 2);
  assert.ok((await page.locator('.node-datasetVersion').count()) >= 2);
  assert.ok((await page.locator('.node-modelVersion').count()) >= 2);
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.screenshot({ path: `${artifactDirectory}/mlflow-lineage.png`, fullPage: true });

  assert.deepEqual(pageErrors, []);
  const summary = {
    projectId: verified.projectId,
    origin: base,
    checks: [
      'SDK metric history and parameters in the native Run view',
      'Logged Model files associated with their source Run',
      'automatic worker evaluation result and SDK parameters',
      'registered model and candidate alias',
      'dataset, Run, Logged Model and registered version lineage',
      'no browser exceptions or API alerts',
    ],
    pageErrors,
  };
  await writeFile(
    `${artifactDirectory}/browser-integration.json`,
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
