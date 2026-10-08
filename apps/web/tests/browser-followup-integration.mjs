import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openProjectCreation } from './projectCreation.mjs';

const { chromium } = await import(pathToFileURL(process.env.MMT_PLAYWRIGHT_MODULE).href);
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Use only the local development API');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.MMT_CHROMIUM_PATH,
  args: ['--no-sandbox'],
});
const errors = [];
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;

async function login(context, email) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('表示名').fill('Web追加検証担当');
  await page.getByRole('button', { name: '開発モードでログイン' }).click();
  // A new user has no projects and the empty navigation has no visible box yet.
  await page.getByRole('button', { name: 'ログアウト', exact: true }).waitFor();
  return page;
}

async function getJson(page, path) {
  const response = await page.request.get(`${base}/api${path}`);
  assert.equal(response.ok(), true, `${path}: HTTP ${response.status()}`);
  return response.json();
}

async function takeScreenshot(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
}

try {
  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    extraHTTPHeaders: { Origin: base },
  });
  const adminPage = await login(adminContext, 'admin@localhost');
  console.log('Real API: compact default Runs columns');
  assert.equal((await getJson(adminPage, '/auth/me')).user.isAdmin, true);
  const demo = (await getJson(adminPage, '/projects')).items.find(
    (project) => project.name === 'Mado Model Tracking Demo',
  );
  assert.ok(demo, 'The parent-provided demo project is required');
  await adminPage.goto(`${base}/projects/${demo.id}/experiments`);
  await adminPage.getByRole('link', { name: 'CPU linear regression', exact: true }).waitFor();
  const table = adminPage.locator('.runs-page table');
  assert.equal(await table.locator('th').filter({ hasText: 'Metrics' }).count(), 2);
  assert.equal(await table.locator('th').filter({ hasText: 'パラメータ' }).count(), 2);
  const metricBounds = await table
    .locator('th')
    .filter({ hasText: 'Metrics' })
    .nth(1)
    .boundingBox();
  assert.ok(metricBounds.x + metricBounds.width < 1440, 'real metrics are off screen');
  await takeScreenshot(adminPage, 'runs-real-light');

  const projectAdminContext = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    extraHTTPHeaders: { Origin: base },
  });
  const projectAdminPage = await login(
    projectAdminContext,
    'web-plugin-project-admin@example.invalid',
  );
  console.log('Real API: project admin registration is forbidden');
  assert.equal((await getJson(projectAdminPage, '/auth/me')).user.isAdmin, false);
  const projectName = 'Web followup permissions';
  let project = (await getJson(projectAdminPage, '/projects')).items.find(
    (project) => project.name === projectName,
  );
  if (!project) {
    await openProjectCreation(projectAdminPage, {
      base,
      projects: (await getJson(projectAdminPage, '/projects')).items,
    });
    await projectAdminPage.getByRole('dialog').getByLabel('名前').fill(projectName);
    await projectAdminPage
      .getByRole('dialog')
      .getByLabel('説明')
      .fill('Plugin登録のglobal admin制限を確認するローカル検証記録');
    await projectAdminPage
      .getByRole('dialog')
      .getByRole('button', { name: '作成', exact: true })
      .click();
    await projectAdminPage.getByRole('dialog').waitFor({ state: 'hidden' });
    project = (await getJson(projectAdminPage, '/projects')).items.find(
      (project) => project.name === projectName,
    );
  }
  assert.equal(project.role, 'admin');
  const pluginPath = `/projects/${project.id}/plugins`;
  await projectAdminPage.goto(base + pluginPath);
  await projectAdminPage.getByRole('heading', { name: 'Plugins', exact: true }).waitFor();
  assert.equal(
    await projectAdminPage.getByRole('button', { name: 'Pluginを登録', exact: true }).count(),
    0,
  );
  assert.equal(await projectAdminPage.getByRole('dialog').count(), 0);
  const pluginsBefore = (await getJson(projectAdminPage, pluginPath)).items;
  const forbidden = await projectAdminPage.request.post(base + '/api' + pluginPath, {
    data: {
      name: 'Web forbidden plugin',
      baseUrl: 'http://127.0.0.1:9',
      tokenEnv: 'MMT_WEB_FOLLOWUP_UNCONFIGURED_TOKEN',
      enabled: true,
    },
  });
  assert.equal(forbidden.status(), 403, 'Project admin must not register server secrets');
  assert.equal((await getJson(projectAdminPage, pluginPath)).items.length, pluginsBefore.length);

  // An explicitly unconfigured localhost connection verifies real error handling,
  // without sending any server secret or claiming that a collector is connected.
  await adminPage.goto(base + pluginPath);
  console.log('Real API: global admin registers an explicitly unconfigured localhost plugin');
  await adminPage.getByRole('button', { name: 'Pluginを登録', exact: true }).waitFor();
  const pluginName = 'Web followup approved plugin (unconfigured)';
  let plugin = (await getJson(adminPage, pluginPath)).items.find(
    (plugin) => plugin.name === pluginName,
  );
  if (!plugin) {
    await adminPage.getByRole('button', { name: 'Pluginを登録', exact: true }).click();
    const dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('名前').fill(pluginName);
    await dialog.getByLabel('接続先URL').fill('http://127.0.0.1:9');
    await dialog
      .getByLabel('トークンを参照する環境変数名')
      .fill('MMT_WEB_FOLLOWUP_UNCONFIGURED_TOKEN');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    plugin = (await getJson(adminPage, pluginPath)).items.find(
      (plugin) => plugin.name === pluginName,
    );
  }
  assert.ok(plugin);
  await adminPage.reload();
  await adminPage.getByRole('button', { name: pluginName, exact: true }).waitFor();
  await projectAdminPage.goto(base + pluginPath + '?id=' + plugin.id);
  console.log('Real API: project admin uses approved plugin and sees actual errors');
  await projectAdminPage.getByRole('button', { name: '接続を確認', exact: true }).waitFor();
  assert.equal(
    await projectAdminPage.getByRole('button', { name: 'Pluginを登録', exact: true }).count(),
    0,
  );
  const checkResponse = projectAdminPage.waitForResponse((response) =>
    response.url().endsWith('/plugins/' + plugin.id + '/check'),
  );
  await projectAdminPage.getByRole('button', { name: '接続を確認', exact: true }).click();
  assert.equal((await checkResponse).status(), 503);
  await projectAdminPage
    .getByRole('alert')
    .filter({ hasText: 'token環境変数が設定されていません' })
    .waitFor();
  assert.equal(await projectAdminPage.getByText('接続を確認しました', { exact: true }).count(), 0);
  await projectAdminPage.getByLabel('データセットを検索').fill('verification');
  const searchResponse = projectAdminPage.waitForResponse((response) =>
    response.url().endsWith('/datasets/search'),
  );
  await projectAdminPage.getByRole('button', { name: '検索', exact: true }).click();
  assert.equal((await searchResponse).status(), 503);
  await projectAdminPage.getByRole('alert').waitFor();
  assert.equal(
    await projectAdminPage.getByRole('button', { name: 'インポート', exact: true }).count(),
    0,
  );
  const metricsResponse = await projectAdminPage.request.get(
    base + '/api' + pluginPath + '/' + plugin.id + '/metrics',
  );
  assert.equal(metricsResponse.status(), 503);
  assert.equal((await metricsResponse.json()).code, 'plugin_token_unavailable');
  const retryResponse = projectAdminPage.waitForResponse((response) =>
    response.url().endsWith('/events/retry'),
  );
  await projectAdminPage.getByRole('button', { name: 'イベントを再送', exact: true }).click();
  const queuedResponse = await retryResponse;
  assert.equal(queuedResponse.status(), 200);
  const queued = (await queuedResponse.json()).queued;
  await projectAdminPage
    .getByText('イベントをキューに追加しました: ' + queued, { exact: true })
    .waitFor();
  assert.equal(
    await projectAdminPage.getByRole('heading', { name: 'Storage metrics', exact: true }).count(),
    0,
  );
  await takeScreenshot(projectAdminPage, 'plugins-real-project-admin');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'passed',
      projectId: project.id,
      pluginId: plugin.id,
      projectAdminRegistrationStatus: forbidden.status(),
      unconfiguredCheckSearchMetricsStatus: 503,
      retryStatus: queuedResponse.status(),
      queued,
      realCollector: 'not connected; error path only',
    }),
  );
} finally {
  await browser.close();
}
