import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
});
const context = await browser.newContext();
const api = createBrowserApi();
api.state.loggedIn = true;
const plugin = api.state.plugins[0];
const pluginListPath = `/projects/${api.state.project.id}/plugins`;
const pluginPath = `${pluginListPath}/${plugin.id}`;
const importedDatasets = [];
const pageErrors = [];
let connectionRevision = 0;
let pluginListGate;
let searchGate;
let releasePluginList;
let releaseSearch;
let closing = false;

function createPluginManifest(revision) {
  return {
    id: `review-plugin-${revision}`,
    name: plugin.name,
    version: `${revision + 1}.0.0`,
    protocolVersion: '1.0',
    capabilities: ['datasets.search', 'datasets.import', ...(revision % 2 === 0 ? ['storage:metrics'] : [])],
  };
}
function createPluginDataset(revision) {
  return {
    externalId: `review-dataset-${revision}`,
    namespace: 'review',
    name: `dataset-${revision}`,
    version: 'v1',
    uri: `file:///review/${revision}`,
    digest: `review-digest-${revision}`,
    schema: {},
    metadata: {},
  };
}

await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname.replace(/^\/api/, '');
  const method = request.method();
  const body = request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : {};
  const reply = (payload) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) })
    .catch((error) => { if (!closing) throw error; });
  if (pathname === pluginListPath && method === 'GET') {
    if (pluginListGate) await pluginListGate;
    return reply({ items: api.state.plugins });
  }
  if (pathname === pluginPath && method === 'PATCH') {
    if ((body.baseUrl && body.baseUrl !== plugin.baseUrl) || (body.tokenEnv && body.tokenEnv !== plugin.tokenEnv)) {
      connectionRevision++;
      plugin.manifest = null;
    }
    Object.assign(plugin, body);
    return reply(plugin);
  }
  if (pathname === `${pluginPath}/check`) {
    plugin.manifest = createPluginManifest(connectionRevision);
    return reply(plugin.manifest);
  }
  if (pathname === `${pluginPath}/datasets/search`) {
    const matchingDataset = createPluginDataset(connectionRevision);
    if (searchGate) await searchGate;
    return reply({ items: [matchingDataset] });
  }
  if (pathname === `${pluginPath}/datasets/import`) {
    importedDatasets.push({ revision: connectionRevision, dataset: body.dataset });
    return reply({ ...api.state.datasetVersions[0], ...body.dataset });
  }
  return api.route(route);
});

const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(error.message));
const dialog = () => page.getByRole('dialog').last();
const row = (revision) => page.getByText(`review/dataset-${revision}`, { exact: true });
const metrics = () => page.locator('.storage-metrics');
const imports = () => page.getByRole('button', { name: 'インポート', exact: true });

async function checkConnection(revision) {
  await page.getByRole('button', { name: '接続を確認', exact: true }).click();
  await page.getByText(`${revision + 1}.0.0`, { exact: true }).waitFor();
  const details = page.locator('.plugin-manifest');
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
  await details.getByText(new RegExp(`review-plugin-${revision}`)).waitFor();
  assert.equal(await metrics().count(), revision % 2 === 0 ? 1 : 0);
}
async function searchConnection(revision) {
  await page.getByLabel('データセットを検索', { exact: true }).fill(`query-${revision}`);
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await row(revision).waitFor();
}
async function editConnection(field, value) {
  await page.getByRole('button', { name: 'Pluginを編集', exact: true }).click();
  await dialog().getByLabel(field).fill(value);
  // Hold the parent reload so stale results cannot be hidden by a fast GET response.
  pluginListGate = new Promise((resolve) => { releasePluginList = resolve; });
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await imports().count(), 0, 'Old search results can still be imported after saving a different connection');
  assert.equal(await metrics().count(), 0, 'Old storage capability remains before the parent reload');
  assert.equal(await page.locator('.plugin-manifest').getByText(/review-plugin-/).count(), 0);
  assert.equal(await page.getByLabel('データセットを検索', { exact: true }).inputValue(), '');
  pluginListGate = undefined;
  releasePluginList();
  await page.getByText(value, { exact: true }).last().waitFor();
  const details = page.locator('.plugin-manifest');
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
  await details.getByText('接続確認でManifestを取得してください。', { exact: true }).waitFor();
  assert.equal(await imports().count(), 0);
  assert.equal(await metrics().count(), 0);
}

try {
  console.log('Plugin connections: search, URL edit, immediate cache reset, new check/search/import');
  await page.goto(`${process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182'}/projects/${api.state.project.id}/plugins`);
  await checkConnection(0);
  await searchConnection(0);
  await editConnection('接続先URL', 'http://new-provider.invalid');
  await checkConnection(1);
  await searchConnection(1);
  await imports().click();
  await page.getByRole('status').filter({ hasText: 'dataset-1' }).waitFor();
  assert.equal(importedDatasets.at(-1).dataset.externalId, 'review-dataset-1');

  console.log('Plugin connections: tokenEnv-only edit, new capability, enable/disable');
  await editConnection('トークンを参照する環境変数名', 'UI_UPDATED_PLUGIN_TOKEN');
  await checkConnection(2);
  await searchConnection(2);
  await page.getByTestId('plugin-toggle').click();
  await page.getByRole('button', { name: '接続を確認', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-testid="plugin-toggle"]')?.textContent === 'Pluginを有効にする');
  assert.equal(await page.getByRole('button', { name: '接続を確認', exact: true }).isDisabled(), true);
  assert.equal(await imports().count(), 0);
  assert.equal(await metrics().count(), 0);
  await page.getByTestId('plugin-toggle').click();
  await row(2).waitFor();
  assert.equal(await page.getByRole('button', { name: '接続を確認', exact: true }).isDisabled(), false);
  assert.equal(await metrics().count(), 1);
  await imports().click();
  await page.getByRole('status').filter({ hasText: 'dataset-2' }).waitFor();

  console.log('Plugin connections: external settings change discards a late search response');
  searchGate = new Promise((resolve) => { releaseSearch = resolve; });
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/datasets/search'));
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await requested;
  Object.assign(plugin, { baseUrl: 'http://external-provider.invalid', manifest: null });
  connectionRevision++;
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await page.getByText(plugin.baseUrl, { exact: true }).last().waitFor();
  assert.equal(await imports().count(), 0);
  assert.equal(await metrics().count(), 0);
  assert.equal(await page.getByLabel('データセットを検索', { exact: true }).inputValue(), '');
  const responded = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/datasets/search'));
  searchGate = undefined;
  releaseSearch();
  const oldResponse = await responded;
  await oldResponse.finished();
  await page.getByLabel('データセットを検索', { exact: true }).focus();
  assert.equal(await imports().count(), 0, 'The previous connection exposed an import action after its response arrived');
  assert.equal(await row(2).count(), 0, 'The previous connection restored its old results before a new search');
  await checkConnection(3);
  await searchConnection(3);
  assert.equal(await row(2).count(), 0, 'A late response from the previous connection reappeared');
  await imports().click();
  await page.getByRole('status').filter({ hasText: 'dataset-3' }).waitFor();
  assert.deepEqual(importedDatasets.map((item) => item.dataset.externalId), ['review-dataset-1', 'review-dataset-2', 'review-dataset-3']);
  assert.deepEqual(pageErrors, []);
  console.log('Plugin connection browser checks passed.');
} finally {
  closing = true;
  releasePluginList?.();
  releaseSearch?.();
  await browser.close();
}
