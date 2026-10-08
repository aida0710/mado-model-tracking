/** Verify container registration and automation controls against the running local API. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('MMT_PLAYWRIGHT_MODULE is required');
const { chromium } = await import(pathToFileURL(modulePath).href);
const verificationDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const artifactDirectory = `artifacts/verification/${verificationDate}/containers`;
await mkdir(artifactDirectory, { recursive: true });
const verified = JSON.parse(await readFile(`${artifactDirectory}/container-integration.json`, 'utf8'));
const inferenceProgram = await readFile('scripts/fixtures/containerInference.mjs', 'utf8');
const verificationSuffix = Date.now().toString();
const codeVersionName = `browser-${verificationSuffix}`;
const ruleName = `Browser-created evaluation ${verificationSuffix}`;
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const projectBase = `/projects/${verified.projectId}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
let createdRuleId;
page.on('pageerror', (error) => pageErrors.push(error.message));

function getRequiredField(dialog, label) {
  // Required fields include the marker in their label text, unlike optional controls.
  return dialog.getByLabel(`${label} *`, { exact: true });
}

try {
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill('admin@localhost');
  await page.getByLabel('表示名').fill('開発管理者');
  await page.getByRole('button', { name: '開発モードでログイン', exact: true }).click();
  await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor();
  await page.getByLabel('プロジェクト', { exact: true }).selectOption(verified.projectId);
  await page.goto(`${base}${projectBase}/models`);
  await page.getByRole('tab', { name: '自動実行履歴', exact: true }).click();
  await page.getByRole('link', { name: 'Runを開く', exact: true }).first().waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: 'ダークテーマ', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${artifactDirectory}/automation-history.png`, fullPage: true });
  await page.getByRole('button', { name: 'ライトテーマ', exact: true }).click();

  await page.goto(`${base}${projectBase}/codes?version=${verified.sourceCodeVersionId}`);
  await page.getByText(verified.image, { exact: true }).waitFor();
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  const versionDialog = page.getByRole('dialog');
  await getRequiredField(versionDialog, 'Version').fill(codeVersionName);
  await getRequiredField(versionDialog, 'Runtime').selectOption('docker');
  await getRequiredField(versionDialog, 'Docker image（digest固定）').fill(verified.image);
  await getRequiredField(versionDialog, 'ソース形式').selectOption('none');
  await getRequiredField(versionDialog, '実行コマンド（引数のJSON配列）').fill(
    JSON.stringify(['node', '--input-type=module', '-e', inferenceProgram]),
  );
  await getRequiredField(versionDialog, '対応モデル系列（1行に1件）').fill('linear');
  await getRequiredField(versionDialog, '対応する実行種別').selectOption(['inference', 'evaluation']);
  const [versionResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === 'POST' && /\/codes\/[^/]+\/versions$/.test(new URL(response.url()).pathname),
    ),
    versionDialog.getByRole('button', { name: '保存', exact: true }).click(),
  ]);
  assert.equal(versionResponse.status(), 201);
  const codeVersion = await versionResponse.json();
  assert.equal(codeVersion.source, null);
  assert.equal(codeVersion.runtime.kind, 'docker');
  assert.equal(codeVersion.runtime.image, verified.image);
  await versionDialog.waitFor({ state: 'hidden' });
  await page.goto(`${base}${projectBase}/codes?version=${verified.sourceCodeVersionId}`);
  await page.getByText(verified.image, { exact: true }).waitFor();
  await page.screenshot({ path: `${artifactDirectory}/docker-code.png` });

  await page.goto(`${base}${projectBase}/models`);
  await page.getByRole('tab', { name: '自動実行ルール', exact: true }).click();
  await page.getByRole('button', { name: '自動実行ルールを作成', exact: true }).click();
  const ruleDialog = page.getByRole('dialog');
  await getRequiredField(ruleDialog, '名前').fill(ruleName);
  await getRequiredField(ruleDialog, '対象モデル系列').selectOption('linear');
  await getRequiredField(ruleDialog, '実行種別').selectOption('evaluation');
  await getRequiredField(ruleDialog, 'Experiments').selectOption(verified.experimentId);
  await getRequiredField(ruleDialog, 'コード版').selectOption(codeVersion.id);
  await getRequiredField(ruleDialog, 'Compute target').selectOption(verified.targetId);
  await ruleDialog.getByLabel('入力データセット版', { exact: true }).selectOption(verified.inputDatasetVersionId);
  await ruleDialog.getByLabel('有効', { exact: true }).uncheck();
  const [ruleResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/automation-rules'),
    ),
    ruleDialog.getByRole('button', { name: '作成', exact: true }).click(),
  ]);
  assert.equal(ruleResponse.status(), 201);
  const rule = await ruleResponse.json();
  createdRuleId = rule.id;
  assert.equal(rule.enabled, false);
  assert.equal(rule.codeVersionId, codeVersion.id);
  await ruleDialog.waitFor({ state: 'hidden' });
  const ruleRow = page.getByRole('row').filter({ hasText: ruleName });
  await ruleRow.getByRole('button', { name: `${ruleName}: 有効にする`, exact: true }).click();
  await ruleRow.getByRole('button', { name: `${ruleName}: 無効にする`, exact: true }).click();
  await ruleRow.getByRole('button', { name: `${ruleName}: 有効にする`, exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(pageErrors, []);
  const summary = {
    projectId: verified.projectId,
    codeVersionId: codeVersion.id,
    ruleId: rule.id,
    checks: [
      'actual automation execution history and Run links',
      'Docker code registration with image digest and container entrypoint',
      'automation rule creation with pinned versions and compatible target',
      'rule enable/disable persisted through the real API',
      'light/dark screens without browser errors',
    ],
    pageErrors,
  };
  await writeFile(`${artifactDirectory}/browser-integration.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  try {
    if (createdRuleId) {
      const response = await page.request.patch(
        `${base}/api${projectBase}/automation-rules/${createdRuleId}`,
        { data: { enabled: false }, headers: { Origin: base } },
      );
      assert.equal(response.status(), 200, 'Verification rule must be disabled after browser checks');
    }
  } finally {
    await browser.close();
  }
}
