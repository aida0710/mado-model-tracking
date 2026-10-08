// Saved views of the Run list against a development API (AUTH_MODE=development): the columns
// (order, width, description), search, sort and chart layout saved as a shared view open the same
// in another browser context for a viewer, another user's private view falls back to the default
// display with a notice, and changes after opening show "unsaved changes" until overwritten.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
assert.equal(
  new URL(base).hostname,
  '127.0.0.1',
  'This verification creates records in the local development app',
);
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const errors = [];
const pages = [];

async function signIn(email, displayName) {
  // A fresh context per user: nothing from the other user's localStorage can leak into the view.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('表示名').fill(displayName);
  const loginButton = page.getByRole('button', { name: '開発モードでログイン' });
  await loginButton.click();
  await loginButton.waitFor({ state: 'detached' });
  return page;
}

function apiClient(page) {
  const call = async (method, path, body) => {
    const response = await page.request.fetch(`${base}/api${path}`, {
      method,
      headers: { Origin: new URL(base).origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { data: JSON.stringify(body) }),
    });
    assert.equal(response.ok(), true, `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? undefined : response.json();
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
  };
}

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
}

const headerKeys = (page) =>
  page.locator('table.run-table thead th[data-column]').evaluateAll((cells) =>
    cells.map((cell) => cell.dataset.column),
  );
const columnWidth = (page, key) =>
  page
    .locator(`table.run-table thead th[data-column="${key}"]`)
    .evaluate((cell) => cell.style.width);
const rowNames = (page) => page.locator('table.run-table tbody .run-name').allTextContents();
const unsavedBadge = (page) => page.locator('.saved-views-bar').getByText('未保存の変更');

async function toggleColumn(page, label) {
  const menu = page.locator('.run-toolbar .column-menu');
  if (!(await menu.evaluate((element) => element.open))) await menu.locator('summary').click();
  await menu.getByLabel(label, { exact: true }).click();
  await menu.locator('summary').click();
}

const DESCRIPTION = ['## 学習率を下げた比較', '', '- lr: **0.0005**', '- warmup: 500 step'].join('\n');
// The chart arrangement the owner has in this browser before saving it into the view.
const ownerLayout = {
  version: 1,
  columns: 12,
  panels: [
    {
      id: 'loss-panel',
      title: '学習損失（保存ビュー）',
      metricKeys: ['loss'],
      xAxis: { kind: 'step' },
      yScale: 'log',
      smoothing: { kind: 'ema', weight: 0.5 },
      showRange: true,
      layout: { x: 0, y: 0, w: 12, h: 2 },
    },
    {
      id: 'acc-panel',
      title: '精度（保存ビュー）',
      metricKeys: ['acc'],
      xAxis: { kind: 'step' },
      yScale: 'linear',
      smoothing: { kind: 'none', weight: 0 },
      showRange: false,
      layout: { x: 0, y: 2, w: 6, h: 2 },
    },
  ],
};

try {
  const owner = await signIn('views-owner@localhost', 'ビュー作成者');
  const ownerApi = apiClient(owner);
  const project = await ownerApi.post('/projects', {
    name: `Saved views verification ${new Date().toISOString()}`,
  });
  const projectBase = `${base}/projects/${project.id}`;
  const experiment = await ownerApi.post(`/projects/${project.id}/experiments`, { name: 'ビュー検証' });
  const runs = {};
  for (const [name, loss, acc, lr] of [
    ['bert-small', 0.42, 0.81, 0.001],
    ['bert-large', 0.31, 0.88, 0.0005],
    ['gpt-tiny', 0.55, 0.7, 0.002],
  ]) {
    const run = await ownerApi.post(`/projects/${project.id}/runs`, {
      experimentId: experiment.id,
      name,
      kind: 'training',
      parameters: { lr },
      tags: { model: name.split('-')[0] },
    });
    const timestamp = new Date().toISOString();
    await ownerApi.post(`/projects/${project.id}/runs/${run.id}/metrics`, {
      metrics: [0, 1, 2].flatMap((step) => [
        { name: 'loss', value: loss + (2 - step) * 0.1, step, timestamp },
        { name: 'acc', value: acc - (2 - step) * 0.05, step, timestamp },
      ]),
    });
    runs[name] = run;
  }
  await ownerApi.put(`/projects/${project.id}/runs/${runs['bert-large'].id}/note`, {
    content: DESCRIPTION,
  });

  console.log('Owner: arrange columns, search, sort and charts, then save a shared view');
  await owner.evaluate(
    ([key, layout]) => window.localStorage.setItem(key, JSON.stringify(layout)),
    [`mmt.chartPanels.v1:${project.id}:runList`, ownerLayout],
  );
  await owner.goto(`${projectBase}/experiments`);
  await owner.locator('table.run-table').waitFor();
  await owner.getByLabel('検索', { exact: true }).fill('bert');
  await owner.getByRole('button', { name: '絞り込み' }).click();
  await owner.waitForFunction(() => document.querySelectorAll('table.run-table tbody tr').length === 2);
  await owner.getByLabel('並び順').selectOption('metric:asc:loss');
  await owner.waitForFunction(
    () => document.querySelector('table.run-table tbody .run-name')?.textContent === 'bert-large',
  );
  await toggleColumn(owner, '説明');
  await toggleColumn(owner, 'tags.model');
  await toggleColumn(owner, '作成日時');
  // Description moves two places left with the keyboard; loss gets 48px wider.
  const descriptionLabel = owner.locator('th[data-column="description"] .run-column-label');
  await descriptionLabel.focus();
  await owner.keyboard.press('Alt+ArrowLeft');
  await owner.keyboard.press('Alt+ArrowLeft');
  const lossResizer = owner.locator('th[data-column="metrics.loss"] .run-column-resizer');
  await lossResizer.focus();
  for (let press = 0; press < 3; press++) await owner.keyboard.press('ArrowRight');
  const ownerHeaders = await headerKeys(owner);
  assert.deepEqual(ownerHeaders, [
    'status',
    'duration',
    'metrics.acc',
    'metrics.loss',
    'description',
    'params.lr',
    'user',
    'tags.model',
  ]);
  const lossWidth = await columnWidth(owner, 'metrics.loss');
  assert.match(lossWidth, /^\d+px$/);
  await owner.getByRole('button', { name: '図を表示' }).click();
  await owner.getByRole('heading', { name: '学習損失（保存ビュー）' }).waitFor();

  await owner.getByRole('button', { name: '名前を付けて保存' }).click();
  const saveDialog = owner.getByRole('dialog');
  await saveDialog.getByLabel('ビューの名前').fill('BERT の損失比較');
  await saveDialog.getByLabel('プロジェクトで共有').check();
  await saveDialog.getByRole('button', { name: '保存' }).click();
  await saveDialog.waitFor({ state: 'detached' });
  await owner.waitForURL(/[?&]view=/);
  const sharedViewId = new URL(owner.url()).searchParams.get('view');
  await owner.locator('.saved-views-bar').getByText('ビュー: BERT の損失比較').waitFor();
  assert.equal(await unsavedBadge(owner).count(), 0, 'A just saved view has no changes');
  const stored = await ownerApi.get(`/projects/${project.id}/saved-views/${sharedViewId}`);
  assert.equal(stored.visibility, 'project');
  assert.deepEqual(stored.state.experimentIds, []);
  assert.equal(stored.state.filter, "attributes.run_name ILIKE '%bert%'");
  assert.deepEqual(stored.state.orderBy, ['metrics.loss ASC']);
  assert.deepEqual(stored.state.columns.map((column) => column.key), ownerHeaders);
  assert.equal(
    stored.state.columns.find((column) => column.key === 'metrics.loss').width,
    Number.parseInt(lossWidth, 10),
  );
  assert.deepEqual(
    stored.state.chartPanels.panels.map((panel) => panel.title).sort(),
    ['学習損失（保存ビュー）', '精度（保存ビュー）'],
  );
  await screenshot(owner, 'saved-view-owner');

  console.log('Owner: a change shows "unsaved changes" until it is saved over the view');
  await toggleColumn(owner, 'tags.model');
  await unsavedBadge(owner).waitFor();
  await toggleColumn(owner, 'tags.model');
  await unsavedBadge(owner).waitFor({ state: 'detached' });
  await owner.getByRole('button', { name: '図を削除' }).last().click();
  await unsavedBadge(owner).waitFor();
  await owner.getByRole('button', { name: '上書き保存' }).click();
  await unsavedBadge(owner).waitFor({ state: 'detached' });
  const overwritten = await ownerApi.get(`/projects/${project.id}/saved-views/${sharedViewId}`);
  assert.equal(overwritten.state.chartPanels.panels.length < 2, true, 'The removed panel is saved');
  const savedPanelTitles = overwritten.state.chartPanels.panels.map((panel) => panel.title);
  // The owner's own stored layout is untouched by edits inside the view.
  const ownerStoredLayout = await owner.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key)),
    `mmt.chartPanels.v1:${project.id}:runList`,
  );
  assert.equal(ownerStoredLayout.panels.length, 2);

  console.log('Owner: a private view for themselves');
  await owner.getByRole('button', { name: '名前を付けて保存' }).click();
  await owner.getByRole('dialog').getByLabel('ビューの名前').fill('自分だけの下書き');
  await owner.getByRole('dialog').getByRole('button', { name: '保存' }).click();
  await owner.getByRole('dialog').waitFor({ state: 'detached' });
  await owner.locator('.saved-views-bar').getByText('ビュー: 自分だけの下書き').waitFor();
  const privateViewId = new URL(owner.url()).searchParams.get('view');
  assert.notEqual(privateViewId, sharedViewId);

  console.log('Viewer: the shared view URL opens the same display in another browser context');
  const viewer = await signIn('views-viewer@localhost', 'ビュー閲覧者');
  const viewerUser = (await apiClient(viewer).get('/auth/me')).user;
  await ownerApi.put(`/projects/${project.id}/members/${viewerUser.id}`, { role: 'viewer' });
  await viewer.goto(`${projectBase}/experiments?view=${sharedViewId}`);
  await viewer.locator('.saved-views-bar').getByText('ビュー: BERT の損失比較').waitFor();
  await viewer.waitForFunction(() => document.querySelectorAll('table.run-table tbody tr').length === 2);
  assert.equal(await viewer.getByLabel('検索', { exact: true }).inputValue(), 'bert');
  assert.equal(await viewer.getByLabel('並び順').inputValue(), 'metric:asc:loss');
  assert.deepEqual(await rowNames(viewer), ['bert-large', 'bert-small']);
  assert.deepEqual(await headerKeys(viewer), ownerHeaders);
  assert.equal(await columnWidth(viewer, 'metrics.loss'), lossWidth);
  for (const title of savedPanelTitles)
    await viewer.getByRole('heading', { name: title }).waitFor();
  assert.equal(
    await viewer.locator('.chart-panel').count(),
    savedPanelTitles.length,
    'The viewer sees the view layout, not a default one',
  );
  assert.equal(await unsavedBadge(viewer).count(), 0);
  assert.equal(await viewer.getByRole('button', { name: '上書き保存' }).count(), 0);
  assert.equal(await viewer.getByRole('button', { name: '削除', exact: true }).count(), 0);

  console.log('Viewer: the description column shows the first line and the whole Markdown on hover');
  const descriptionCell = viewer.locator('.run-description-cell');
  assert.equal(await descriptionCell.count(), 1);
  assert.equal(await descriptionCell.locator('.run-description-summary').textContent(), '学習率を下げた比較');
  assert.equal(await viewer.locator('th[data-column^="tags.mlflow.note"]').count(), 0);
  await descriptionCell.hover();
  const popover = viewer.getByRole('tooltip');
  await popover.locator('strong', { hasText: '0.0005' }).waitFor();
  assert.equal(await popover.locator('li').count(), 2);
  await screenshot(viewer, 'saved-view-viewer');
  await viewer.mouse.move(0, 0);
  await popover.waitFor({ state: 'detached' });

  console.log('Viewer: a change shows "unsaved changes"; saving is only offered as a private copy');
  await viewer.getByLabel('並び順').selectOption('name');
  await unsavedBadge(viewer).waitFor();
  assert.equal(await viewer.getByRole('button', { name: '上書き保存' }).count(), 0);
  await viewer.getByRole('button', { name: '名前を付けて保存' }).click();
  assert.equal(await viewer.getByRole('dialog').getByText('公開範囲').count(), 0);
  await viewer.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();

  console.log("Viewer: another user's private view opens the default display with a notice");
  await viewer.goto(`${projectBase}/experiments?view=${privateViewId}`);
  await viewer.getByText('開こうとしたビューは削除されたか、閲覧できません').waitFor();
  await viewer.waitForURL((url) => !url.searchParams.has('view'));
  await viewer.locator('.saved-views-menu summary').getByText('既定の表示').waitFor();
  assert.equal(await viewer.getByLabel('検索', { exact: true }).inputValue(), '');
  await viewer.waitForFunction(() => document.querySelectorAll('table.run-table tbody tr').length === 3);
  const viewerViews = await apiClient(viewer).get(`/projects/${project.id}/saved-views?page=runs`);
  assert.deepEqual(viewerViews.items.map((view) => view.id), [sharedViewId]);
  await screenshot(viewer, 'saved-view-private-fallback');

  console.log('Viewer: the menu lists the shared view and opens it');
  await viewer.locator('.saved-views-menu summary').click();
  await viewer.getByRole('menuitemradio', { name: 'BERT の損失比較' }).click();
  await viewer.locator('.saved-views-bar').getByText('ビュー: BERT の損失比較').waitFor();
  await viewer.waitForFunction(() => document.querySelectorAll('table.run-table tbody tr').length === 2);

  console.log('Owner: deleting the open view returns to the default display');
  await owner.goto(`${projectBase}/experiments?view=${privateViewId}`);
  await owner.locator('.saved-views-bar').getByText('ビュー: 自分だけの下書き').waitFor();
  await owner.locator('.saved-views-bar').getByRole('button', { name: '削除' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: '削除' }).click();
  await owner.waitForURL((url) => !url.searchParams.has('view'));
  await owner.locator('.saved-views-menu summary').getByText('既定の表示').waitFor();

  assert.deepEqual(errors, []);
  console.log('Saved views verification passed');
} catch (failure) {
  for (const [index, page] of pages.entries()) await screenshot(page, `failure-${index}`);
  throw failure;
} finally {
  await browser.close();
}
