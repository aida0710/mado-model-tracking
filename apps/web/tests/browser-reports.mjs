// Shared reports against a development API (AUTH_MODE=development): a report with Markdown, a
// grouped chart (mean and range) fixed at save time and the same chart live, parallel coordinates,
// an audio comparison and a Run list from a Project saved view; metrics logged afterwards change
// the live chart and not the fixed one; two tabs editing at once make the later save a conflict;
// a past revision opens read-only and can be restored; comments; a viewer reads and sees comments
// without any input.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
assert.equal(new URL(base).hostname, '127.0.0.1', 'This verification creates records in the local development app');
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
const fixtureDirectory = new URL('./fixtures/media/', import.meta.url);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const errors = [];

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
}

function apiClient(request) {
  const call = async (method, path, body, contentType = 'application/json') => {
    const response = await request.fetch(`${base}/api${path}`, {
      method,
      headers: { Origin: new URL(base).origin, 'Content-Type': contentType },
      ...(body === undefined ? {} : { data: contentType === 'application/json' ? JSON.stringify(body) : body }),
    });
    assert.equal(response.ok(), true, `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? undefined : response.json();
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body, contentType) => call('PUT', path, body, contentType),
  };
}

// --- Sessions -----------------------------------------------------------------------------------
async function signIn(email, displayName) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('表示名').fill(displayName);
  const loginButton = page.getByRole('button', { name: '開発モードでログイン' });
  await loginButton.click();
  await loginButton.waitFor({ state: 'detached' });
  return { context, page, api: apiClient(context.request) };
}

// --- Report editing helpers ---------------------------------------------------------------------
const embedDialog = (page) => page.getByRole('dialog', { name: '図や表を埋め込む' });

async function addGroupedChart(page, { runNames, mode }) {
  await page.getByRole('button', { name: '図や表を埋め込む' }).click();
  const dialog = embedDialog(page);
  for (const name of runNames) await dialog.getByRole('checkbox', { name }).check();
  await dialog.getByRole('button', { name: '図の設定' }).click();
  const chartDialog = page.getByRole('dialog', { name: '図の設定' });
  await chartDialog.getByRole('checkbox', { name: 'loss', exact: true }).check();
  await chartDialog.locator('.run-grouping-control select').selectOption('param');
  await chartDialog.locator('.run-grouping-control input').fill('lr');
  await chartDialog.getByRole('button', { name: '保存' }).click();
  await chartDialog.waitFor({ state: 'detached' });
  if (mode === 'snapshot') await dialog.getByText('保存時に固定').click();
  await dialog.getByRole('button', { name: '反映' }).click();
  await dialog.waitFor({ state: 'detached' });
}

async function chartSignature(page, index) {
  const chart = page.locator('.report-embed[data-block-type=chart]').nth(index);
  // The mean lines and range bands of the groups; the axes and icons do not depend on the data.
  const lines = chart.locator('path.chart-line, path.chart-band');
  await lines.first().waitFor();
  return lines.evaluateAll((paths) => paths.map((path) => path.getAttribute('d')).join('|'));
}

async function saveEdit(page, message) {
  if (message) await page.getByLabel('変更の説明').fill(message);
  await page.locator('.report-editor-footer').getByRole('button', { name: '保存' }).click();
}

try {
  const admin = await signIn('reports-admin@localhost', 'レポート管理者');
  const project = await admin.api.post('/projects', { name: `Reports verification ${new Date().toISOString()}` });
  const projectBase = `${base}/projects/${project.id}`;
  const experiment = await admin.api.post(`/projects/${project.id}/experiments`, { name: 'レポート検証' });

  console.log('Runs with metrics, two learning rates and audio');
  const runs = [];
  for (const [name, lr, offset] of [
    ['lr-high-a', '0.1', 0.2],
    ['lr-high-b', '0.1', 0.3],
    ['lr-low-a', '0.01', 0],
    ['lr-low-b', '0.01', 0.1],
  ]) {
    const run = await admin.api.post(`/projects/${project.id}/runs`, {
      experimentId: experiment.id,
      name,
      kind: 'training',
      parameters: { lr },
    });
    await admin.api.post(`/projects/${project.id}/runs/${run.id}/metrics`, {
      metrics: [0, 1, 2, 3, 4].map((step) => ({ name: 'loss', value: 1 / (step + 1) + offset, step, timestamp: new Date().toISOString() })),
    });
    runs.push(run);
  }
  for (const [run, letter] of [
    [runs[0], 'a'],
    [runs[2], 'b'],
  ])
    for (const step of [0, 1]) {
      const audio = await readFile(new URL(`run-${letter}-step-${step}.wav`, fixtureDirectory));
      const artifact = await admin.api.put(`/projects/${project.id}/runs/${run.id}/artifacts?path=audio/step-${step}.wav`, audio, 'audio/wav');
      await admin.api.post(`/projects/${project.id}/runs/${run.id}/media`, {
        items: [{ key: 'eval/audio', step, kind: 'audio', artifactId: artifact.id }],
      });
    }
  const savedView = await admin.api.post(`/projects/${project.id}/saved-views`, {
    visibility: 'project',
    page: 'runs',
    name: '低い学習率',
    state: {
      version: 1,
      experimentIds: [experiment.id],
      filter: "params.lr = '0.01'",
      orderBy: [],
      statuses: [],
      kinds: [],
      columns: [],
      chartPanels: { version: 1, columns: 12, panels: [] },
    },
  });

  console.log('Create a report with Markdown, charts, parallel coordinates, audio and a Run list');
  const page = admin.page;
  await page.goto(`${projectBase}/experiments`);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page.getByTestId('reports-page').waitFor();
  await page.getByRole('button', { name: 'レポートを作成' }).click();
  await page.getByLabel('題名').fill('学習率の比較');
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.locator('.report-editor').waitFor();

  await page.getByRole('button', { name: '文章を追加' }).click();
  await page.getByRole('textbox', { name: '文章（Markdown）' }).fill('## 結論\n\n学習率 **0.01** の方が loss が低い。');
  const runNames = runs.map((run) => run.name);
  await addGroupedChart(page, { runNames, mode: 'snapshot' });
  await addGroupedChart(page, { runNames, mode: 'live' });

  await page.getByRole('button', { name: '図や表を埋め込む' }).click();
  let dialog = embedDialog(page);
  await dialog.getByLabel('種類').selectOption({ label: '平行座標' });
  await dialog.getByText('検索式', { exact: true }).click();
  await dialog.getByRole('textbox', { name: '検索式' }).fill('metrics.loss >= 0');
  await dialog.getByRole('checkbox', { name: 'lr', exact: true }).check();
  await dialog.getByLabel('メトリクス', { exact: true }).selectOption('loss');
  await dialog.getByRole('button', { name: '反映' }).click();
  await dialog.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '図や表を埋め込む' }).click();
  dialog = embedDialog(page);
  await dialog.getByLabel('種類').selectOption({ label: 'メディアの比較' });
  await dialog.getByRole('checkbox', { name: runs[0].name }).check();
  await dialog.getByRole('checkbox', { name: runs[2].name }).check();
  await dialog.getByLabel('メディアのキー').selectOption('eval/audio');
  await dialog.getByRole('checkbox', { name: '0', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '1', exact: true }).check();
  await dialog.getByRole('button', { name: '反映' }).click();
  await dialog.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: '図や表を埋め込む' }).click();
  dialog = embedDialog(page);
  await dialog.getByLabel('種類').selectOption({ label: 'Run一覧' });
  await dialog.getByText('保存ビュー', { exact: true }).click();
  await dialog.getByRole('combobox', { name: '保存ビュー' }).selectOption(savedView.id);
  await dialog.getByRole('checkbox', { name: 'Metrics: loss' }).check();
  await dialog.getByRole('checkbox', { name: 'Parameters: lr' }).check();
  await dialog.getByRole('button', { name: '反映' }).click();
  await dialog.waitFor({ state: 'detached' });

  await saveEdit(page, '最初のバージョン');
  await page.locator('.report-editor').waitFor({ state: 'detached' });
  // Creating the report made revision 1 (empty); the first save is revision 2.
  await page.getByText('バージョン 2・レポート管理者が').waitFor();
  await page.locator('.report-embed').nth(4).waitFor();
  assert.equal(await page.locator('.report-embed').count(), 5);
  await page.locator('.report-markdown strong').getByText('0.01').waitFor();
  await page.getByTestId('report-snapshot-mark').getByText('時点で固定').waitFor();
  await page.locator('.report-embed[data-block-type=parallel_coordinates] svg').first().waitFor();
  await page.locator('.report-embed[data-block-type=media] audio').first().waitFor({ state: 'attached' });
  const runTable = page.locator('.report-embed[data-block-type=run_table]');
  await runTable.getByRole('link', { name: 'lr-low-a' }).waitFor();
  assert.equal(await runTable.getByRole('link', { name: 'lr-high-a' }).count(), 0, 'The saved view lists only lr=0.01');
  assert.equal(await page.locator('.report-embed-error').count(), 0);
  const fixedBefore = await chartSignature(page, 0);
  const liveBefore = await chartSignature(page, 1);
  assert.equal(fixedBefore, liveBefore, 'Both charts draw the same data right after saving');
  await screenshot(page, 'report-view');

  console.log('Metrics logged after saving change the live chart only');
  for (const run of runs)
    await admin.api.post(`/projects/${project.id}/runs/${run.id}/metrics`, {
      metrics: [{ name: 'loss', value: 3, step: 8, timestamp: new Date().toISOString() }],
    });
  await page.reload();
  await page.locator('.report-embed[data-block-type=chart]').first().waitFor();
  assert.equal(await chartSignature(page, 0), fixedBefore, 'The fixed chart keeps the saved data');
  assert.notEqual(await chartSignature(page, 1), liveBefore, 'The live chart follows the new metrics');
  await screenshot(page, 'report-snapshot-vs-live');

  console.log('Two tabs: the later save is refused as a conflict');
  const reportUrl = page.url();
  const otherTab = await admin.context.newPage();
  otherTab.on('pageerror', (error) => errors.push(error.message));
  await otherTab.goto(reportUrl);
  await page.getByRole('button', { name: '編集', exact: true }).click();
  await otherTab.getByRole('button', { name: '編集', exact: true }).click();
  await page.getByLabel('題名').fill('学習率の比較（タブA）');
  await saveEdit(page, 'タブAの変更');
  await page.getByText('バージョン 3・レポート管理者が').waitFor();
  await otherTab.getByLabel('題名').fill('学習率の比較（タブB）');
  await saveEdit(otherTab);
  await otherTab.getByTestId('report-conflict').waitFor();
  await screenshot(otherTab, 'report-conflict');
  await otherTab.getByRole('button', { name: '最新のバージョンを読み込む' }).click();
  await otherTab.waitForFunction(() => document.querySelector('.report-editor input')?.value === '学習率の比較（タブA）');
  await otherTab.getByRole('button', { name: '編集をやめる' }).click();
  await otherTab.close();

  console.log('A past revision is read-only and can be restored');
  await page.getByRole('button', { name: 'バージョンの履歴' }).click();
  const history = page.locator('.report-history');
  await history.getByText('タブAの変更').waitFor();
  await history.locator('li', { hasText: '最初のバージョン' }).getByRole('button', { name: '表示' }).click();
  await page.getByTestId('report-past-notice').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('revision'), '2');
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), '学習率の比較');
  assert.equal(await page.getByRole('button', { name: '編集', exact: true }).count(), 0, 'A past revision is read-only');
  await screenshot(page, 'report-past-revision');
  await history.locator('li', { hasText: '最初のバージョン' }).getByRole('button', { name: 'このバージョンに戻す' }).click();
  await page.getByRole('dialog', { name: 'バージョンを戻す' }).getByRole('button', { name: 'このバージョンに戻す' }).click();
  await page.getByText('バージョン 4・レポート管理者が').waitFor();
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), '学習率の比較');
  await history.getByText('バージョン 2 から復元').waitFor();
  await page.locator('.report-embed').nth(4).waitFor();

  console.log('Comments on the report');
  await page.getByPlaceholder('コメントを書く').fill('lr=0.01 で再実験します');
  await page.locator('.comment-thread').getByRole('button', { name: '投稿' }).click();
  await page.locator('.comment-thread').getByText('lr=0.01 で再実験します').waitFor();
  await screenshot(page, 'report-history-and-comments');

  console.log('Viewer: reads the report and the comments without any input');
  const viewer = await signIn('reports-viewer@localhost', 'レポート閲覧者');
  const viewerUser = (await viewer.api.get('/auth/me')).user;
  await admin.api.put(`/projects/${project.id}/members/${viewerUser.id}`, { role: 'viewer' });
  await viewer.page.goto(`${projectBase}/reports`);
  await viewer.page.getByRole('link', { name: '学習率の比較' }).click();
  await viewer.page.locator('.comment-thread').getByText('lr=0.01 で再実験します').waitFor();
  await viewer.page.locator('.report-embed[data-block-type=chart] path.chart-line').first().waitFor();
  assert.equal(await viewer.page.getByRole('button', { name: '編集', exact: true }).count(), 0);
  assert.equal(await viewer.page.getByRole('button', { name: 'アーカイブ' }).count(), 0);
  assert.equal(await viewer.page.locator('.comment-thread textarea').count(), 0);
  await viewer.page.getByRole('button', { name: 'バージョンの履歴' }).click();
  await viewer.page.locator('.report-history li').first().waitFor();
  assert.equal(await viewer.page.getByRole('button', { name: 'このバージョンに戻す' }).count(), 0);
  await viewer.page.goto(`${projectBase}/reports`);
  await viewer.page.getByRole('link', { name: '学習率の比較' }).waitFor();
  assert.equal(await viewer.page.getByRole('button', { name: 'レポートを作成' }).count(), 0);
  await screenshot(viewer.page, 'report-viewer-list');

  console.log('Archive hides the report from the default list');
  await page.goto(reportUrl);
  await page.getByRole('button', { name: 'アーカイブ', exact: true }).click();
  await page.getByRole('dialog', { name: 'レポートをアーカイブ' }).getByRole('button', { name: 'アーカイブ' }).click();
  await page.getByTestId('reports-page').waitFor();
  await page.getByText('レポートはまだありません').waitFor();
  await page.getByText('アーカイブ済みも表示').click();
  await page.getByRole('cell', { name: 'アーカイブ済み' }).waitFor();
  await screenshot(page, 'reports-list-archived');

  assert.deepEqual(errors, []);
  console.log('Reports verification passed');
} catch (failure) {
  // Keeps the screen at the failure for diagnosis.
  for (const context of browser.contexts()) for (const page of context.pages()) console.error(`failure at ${page.url()}`);
  for (const context of browser.contexts())
    for (const [index, page] of context.pages().entries()) await screenshot(page, `failure-${index}`).catch(() => undefined);
  throw failure;
} finally {
  await browser.close();
}
