import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

// Reuse an installed Playwright without changing the shared workspace dependencies.
const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const api = createBrowserApi();
await context.route((url) => url.pathname.startsWith('/api/'), api.route);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const projectBase = `${base}/projects/${api.state.project.id}`;
const artifactsDirectory = process.env.MMT_SCREENSHOT_DIR;
try {
  console.log('Browser check: authentication');
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill('ui-test@example.invalid');
  await page.getByLabel('表示名').fill('UI検証担当');
  assert.equal(api.state.calls.filter((call) => call.path === '/auth/dev-login').length, 0);
  await page.getByRole('button', { name: '開発モードでログイン' }).click();
  await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor();
  await page.getByRole('link', { name: 'training-test-01', exact: true }).waitFor();
  console.log('Browser check: compact default columns');
  const runTable = page.locator('.runs-page table');
  assert.equal(await runTable.locator('th').filter({ hasText: 'Metrics' }).count(), 2);
  assert.equal(await runTable.locator('th').filter({ hasText: 'Parameters' }).count(), 2);
  const headerNames = await runTable.locator('th').allTextContents();
  assert.ok(
    headerNames.findIndex((name) => name.includes('Metrics')) <
      headerNames.findIndex((name) => name.includes('Parameters')),
  );
  const metricBounds = await runTable
    .locator('th')
    .filter({ hasText: 'Metrics' })
    .nth(1)
    .boundingBox();
  assert.ok(metricBounds.x + metricBounds.width < 1440, 'default metrics are off screen');
  const preciseValue = runTable.locator('.compact-value[title="0.123456789123"]');
  assert.equal(await preciseValue.textContent(), '0.1235');
  await page.locator('.column-menu summary').click();
  await page.getByLabel('metrics.val/loss', { exact: true }).check();
  await page.getByLabel('params.spk_emb', { exact: true }).check();
  assert.equal(await runTable.locator('th').filter({ hasText: 'Metrics' }).count(), 3);
  assert.equal(await runTable.locator('th').filter({ hasText: 'Parameters' }).count(), 3);
  await page.getByLabel('metrics.val/loss', { exact: true }).uncheck();
  await page.getByLabel('params.spk_emb', { exact: true }).uncheck();
  await page.locator('.column-menu summary').click();
  if (artifactsDirectory) {
    await mkdir(artifactsDirectory, { recursive: true });
    await page.screenshot({ path: `${artifactsDirectory}/runs-light.png`, fullPage: true });
  }

  await page
    .getByLabel('検索', { exact: true })
    .fill('metrics.val/loss < 0.16 and params.batch_size = 32');
  await page.getByRole('button', { name: '絞り込み', exact: true }).click();
  await page
    .getByRole('link', { name: 'training-test-02', exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByLabel('検索', { exact: true }).fill('');
  await page.getByRole('button', { name: '絞り込み', exact: true }).click();
  await page.getByLabel('Runを選択: training-test-01').check();
  await page.getByLabel('Runを選択: training-test-02').check();
  await page.getByRole('button', { name: '比較', exact: true }).click();
  await page.getByRole('heading', { name: '比較', exact: true }).waitFor();

  console.log('Browser check: run detail');
  const firstRun = api.state.runs[0];
  await page.goto(`${projectBase}/runs/${firstRun.id}`);
  await page.getByRole('heading', { name: firstRun.name, exact: true }).waitFor();
  await page.getByRole('tab', { name: 'System metrics' }).click();
  await page.getByLabel('メトリクス名').selectOption('system/gpu.utilization');
  await page.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  await page.getByText('Browser test artifact', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Artifactをアップロード' }).click();
  await page.getByLabel('ファイル', { exact: true }).setInputFiles({
    name: 'test-upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('test upload'),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'アップロード', exact: true }).click();
  await page.getByRole('button', { name: 'test-upload.txt', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await page.getByText('Browser test log', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Runを編集' }).click();
  await page.getByRole('dialog').getByLabel('名前').fill('edited-training-test');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: 'edited-training-test' }).waitFor();

  console.log('Browser check: all screens');
  for (const [route, heading] of [
    ['models', 'Models'],
    ['codes', 'Code'],
    ['datasets', 'Datasets'],
    ['lineage', 'Lineage'],
    ['compute', 'Compute'],
    ['plugins', 'Plugins'],
    ['settings', 'Settings'],
  ]) {
    await page.goto(`${projectBase}/${route}`);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    console.log(`Browser screen: ${route}`);
    assert.equal(await page.getByRole('alert').count(), 0, `${route} has an error`);
  }
  console.log('Browser check: model version');
  await page.goto(`${projectBase}/codes`);
  await page.getByRole('button', { name: 'Artifactをアップロード', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('ファイル', { exact: true })
    .setInputFiles({
      name: 'source.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('browser source test'),
    });
  await page.getByRole('dialog').getByRole('button', { name: 'アップロード', exact: true }).click();
  await page.getByRole('dialog').getByText('Artifact ID', { exact: true }).waitFor();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '閉じる', exact: true })
    .last()
    .click();
  await page.goto(`${projectBase}/models`);
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Version').fill('v2');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: 'v2', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Aliasを設定' }).click();
  await page.getByRole('dialog').getByLabel('Alias').fill('candidate');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('candidate', { exact: true }).waitFor();

  console.log('Browser check: plugins');
  await page.goto(`${projectBase}/plugins`);
  assert.equal(
    await page.getByRole('heading', { name: 'Storage metrics', exact: true }).count(),
    0,
  );
  assert.equal(
    api.state.calls.filter(
      (call) => call.path.endsWith('/metrics') && call.path.includes('/plugins/'),
    ).length,
    0,
  );
  await page.getByRole('button', { name: 'Pluginを登録', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名前').fill('UI登録Plugin');
  await page.getByRole('dialog').getByLabel('接続先URL').fill('http://test.invalid');
  await page
    .getByRole('dialog')
    .getByLabel('トークンを参照する環境変数名')
    .fill('UI_TEST_PLUGIN_TOKEN');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: 'UI登録Plugin', exact: true }).waitFor();
  assert.equal(api.state.plugins.length, 2, 'global admin registration did not reach the API');
  await page.getByRole('button', { name: 'UI検証Plugin', exact: true }).click();
  let releaseMetrics;
  api.state.metricsGate = new Promise((resolve) => {
    releaseMetrics = resolve;
  });
  await page.getByRole('button', { name: '接続を確認' }).click();
  await page.getByText('接続を確認しました', { exact: true }).waitFor();
  const storageMetrics = page.getByRole('region', { name: 'Storage metrics', exact: true });
  await storageMetrics.getByRole('status').waitFor();
  releaseMetrics();
  api.state.metricsGate = null;
  await storageMetrics.getByRole('heading', { name: 'UI検証ストレージ', exact: true }).waitFor();
  await storageMetrics.getByText('3 GiB', { exact: true }).waitFor();
  assert.equal(await storageMetrics.getByText('1.2M', { exact: true }).count(), 1);
  assert.deepEqual(
    await storageMetrics
      .locator('tr')
      .filter({ hasText: 'unmeasured' })
      .locator('td')
      .allTextContents(),
    ['unmeasured', '—', '—', '—', '2'],
  );
  assert.equal(await storageMetrics.locator('.raw-metrics').getAttribute('open'), null);
  if (artifactsDirectory)
    await page.screenshot({
      path: `${artifactsDirectory}/plugin-metrics-light.png`,
      fullPage: true,
    });
  await storageMetrics.locator('.raw-metrics summary').click();
  assert.ok(
    (await storageMetrics.locator('pre').textContent()).includes('mado_storage_prefix_bytes'),
  );
  api.state.failPluginMetrics = true;
  await storageMetrics.getByRole('button', { name: 'メトリクスを更新' }).click();
  await storageMetrics.getByRole('alert').filter({ hasText: 'metrics unavailable' }).waitFor();
  assert.equal(
    await storageMetrics.locator('table').count(),
    0,
    'failed metrics kept displaying values',
  );
  api.state.failPluginMetrics = false;
  await storageMetrics.getByRole('button', { name: '再試行', exact: true }).click();
  await storageMetrics.getByText('3 GiB', { exact: true }).waitFor();
  const measuredPrometheus = api.state.prometheus;
  api.state.prometheus = '';
  await storageMetrics.getByRole('button', { name: 'メトリクスを更新' }).click();
  await storageMetrics.getByText('容量メトリクスはまだありません', { exact: true }).waitFor();
  assert.equal(await storageMetrics.locator('table').count(), 0);
  api.state.prometheus = measuredPrometheus;
  await storageMetrics.getByRole('button', { name: 'メトリクスを更新' }).click();
  await storageMetrics.getByText('3 GiB', { exact: true }).waitFor();

  console.log('Browser check: project admin plugin permissions');
  api.state.user.isAdmin = false;
  await page.reload();
  await page.getByRole('button', { name: '接続を確認' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Pluginを登録', exact: true }).count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByLabel('トークンを参照する環境変数名').count(), 0);
  const forbiddenStatus = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Forbidden',
        baseUrl: 'http://test.invalid',
        tokenEnv: 'UI_TEST_PLUGIN_TOKEN',
        enabled: true,
      }),
    });
    return response.status;
  }, `/api/projects/${api.state.project.id}/plugins`);
  assert.equal(forbiddenStatus, 403);
  assert.equal(api.state.plugins.length, 2);
  await page.getByRole('button', { name: '接続を確認' }).click();
  await page.getByText('接続を確認しました', { exact: true }).waitFor();
  await storageMetrics.getByRole('button', { name: 'メトリクスを更新' }).click();
  await storageMetrics.getByText('3 GiB', { exact: true }).waitFor();
  await page.getByLabel('データセットを検索').fill('test');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.getByRole('button', { name: 'インポート', exact: true }).click();
  await page.getByText(/保存しました: UI検索データ/).waitFor();
  await page.getByRole('button', { name: 'イベントを再送' }).click();
  await page.getByText(/イベントをキューに追加しました: 2/).waitFor();
  api.state.plugins[0].manifest = {
    ...api.state.plugins[0].manifest,
    capabilities: ['datasets.search', 'datasets.import'],
  };
  const metricsCalls = api.state.calls.filter(
    (call) => call.path.endsWith('/metrics') && call.path.includes('/plugins/'),
  ).length;
  await page.reload();
  await page.getByRole('button', { name: '接続を確認' }).waitFor();
  assert.equal(
    await page.getByRole('heading', { name: 'Storage metrics', exact: true }).count(),
    0,
  );
  assert.equal(
    api.state.calls.filter(
      (call) => call.path.endsWith('/metrics') && call.path.includes('/plugins/'),
    ).length,
    metricsCalls,
  );
  api.state.user.isAdmin = true;

  console.log('Browser check: tokens');
  await page.goto(`${projectBase}/settings`);
  await page.getByRole('button', { name: 'トークンを作成', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名前').fill('browser-test-token');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText(/トークンは一度だけ表示/).waitFor();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '閉じる', exact: true })
    .last()
    .click();
  await page.getByRole('button', { name: '失効', exact: true }).click();
  await page.getByRole('dialog').getByText(/browser-test-token.*失効/).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '失効', exact: true }).click();
  await page.getByText('browser-test-token', { exact: true }).waitFor({ state: 'hidden' });

  console.log('Browser check: launch');
  await page.goto(`${projectBase}/jobs`);
  await page.getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Run name').fill('browser-training-launch');
  await dialog.getByLabel('Experiments').selectOption(api.state.experiments[0].id);
  await dialog.getByLabel('実行種別').selectOption('training');
  await dialog.getByLabel('モデル版', { exact: true }).selectOption(api.state.modelVersions[0].id);
  await dialog.getByLabel('コード版').selectOption(api.state.codeVersions[0].id);
  await dialog.getByRole('button', { name: '次へ', exact: true }).click();
  await dialog.getByLabel('Compute target').selectOption(api.state.targets[0].id);
  await dialog.getByRole('button', { name: '次へ', exact: true }).click();
  api.state.failNextJob = true;
  await dialog.getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  const runPostsBeforeRetry = api.state.calls.filter(
    (call) => call.method === 'POST' && call.path.endsWith('/runs'),
  ).length;
  await dialog.getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    api.state.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs')).length,
    runPostsBeforeRetry,
    'enqueue retry created a duplicate Run',
  );
  assert.equal(api.state.jobs[0].gpuIds.length, 0, 'CPU selection must remain empty');
  await page.getByRole('button', { name: '停止を要求', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('停止要求済み', { exact: true }).waitFor();

  console.log('Browser check: errors/theme/mobile');
  api.state.failRunList = true;
  await page.goto(`${projectBase}/experiments`);
  await page
    .getByRole('alert')
    .filter({ hasText: 'UI verification: database unavailable' })
    .waitFor();
  assert.equal(await page.getByRole('link', { name: 'training-test-02', exact: true }).count(), 0);
  api.state.failRunList = false;
  await page.getByRole('alert').getByRole('button', { name: '再試行', exact: true }).click();
  await page.getByRole('link', { name: 'training-test-02', exact: true }).waitFor();
  await page.getByRole('button', { name: 'ダークテーマ', exact: true }).click();
  if (artifactsDirectory)
    await page.screenshot({ path: `${artifactsDirectory}/runs-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'mobile viewport overflows',
  );
  if (artifactsDirectory)
    await page.screenshot({ path: `${artifactsDirectory}/runs-mobile.png`, fullPage: true });
  api.state.loggedIn = false;
  api.state.authMode = 'oidc';
  const returnPath = `/projects/${api.state.project.id}/runs/${firstRun.id}?tab=details`;
  await page.goto(base + returnPath);
  await page.getByRole('link', { name: 'Authentik', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '開発モードでログイン', exact: true }).count(),
    0,
  );
  await page.getByRole('link', { name: 'Authentik', exact: true }).click();
  await page.waitForURL(base + returnPath);
  await page.getByRole('tab', { name: 'Details', exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  assert.equal(
    api.state.calls.some((call) => call.path.includes('/worker/')),
    false,
  );
  console.log(
    'Browser smoke passed: authentication, all screens, compact columns, filtering, comparison, previews, upload, version/alias, plugin registration permissions/metrics/import, tokens, CPU launch, enqueue retry, cancellation, API errors, theme, mobile.',
  );
} finally {
  await browser.close();
}
