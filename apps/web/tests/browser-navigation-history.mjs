import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}) });
const context = await browser.newContext();
const api = createBrowserApi();
api.state.loggedIn = true;
api.state.codeVersions[0].source = { kind: 'inline', files: { 'main.py': 'print("original")\n' } };
api.state.codeVersions[0].taskTypes = ['inference', 'processing'];
const projectBase = `${process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182'}/projects/${api.state.project.id}`;
const taskPath = `/api/projects/${api.state.project.id}/tasks`;
const taskCount = 2;
// More than one page ensures older records remain accessible.
const historyRunCount = 55;
const tasks = Array.from({ length: taskCount }, (_, index) => ({
  id: `00000000-0000-4000-8000-00000000900${index}`,
  projectId: api.state.project.id,
  experimentId: api.state.experiments[0].id,
  name: `History Task ${index + 1}`,
  description: '', kind: 'inference', codeVersionId: api.state.codeVersions[0].id,
  modelVersionId: null, inputDatasetVersionIds: [], parameters: {}, tags: {},
  targetId: api.state.targets[0].id, gpuIds: [], revision: 1,
  createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z',
}));
const histories = new Map(tasks.map((task, taskIndex) => [task.id,
  Array.from({ length: historyRunCount }, (_, runIndex) => ({
    ...api.state.runs[0],
    id: `00000000-0000-4000-8000-${String(10000 + taskIndex * historyRunCount + runIndex).padStart(12, '0')}`,
    name: `History ${taskIndex + 1} Run ${runIndex + 1}`,
    taskId: task.id, taskRevision: 1, executionMode: 'test',
  })),
]));
const historyRequests = [];
let pendingSave = null;
await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const reply = (payload) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  if (url.pathname === taskPath && request.method() === 'GET') return reply({ items: tasks });
  if (url.pathname.startsWith(taskPath) && url.pathname.endsWith('/runs')) {
    const taskId = url.pathname.split('/').at(-2);
    const runs = histories.get(taskId);
    const cursor = url.searchParams.get('cursor');
    const offset = cursor ? runs.findIndex((run) => run.id === cursor) + 1 : 0;
    const limit = Number(url.searchParams.get('limit'));
    assert.equal(limit, 50);
    const items = runs.slice(offset, offset + limit);
    historyRequests.push({ taskId, cursor });
    return reply({ items, nextCursor: offset + limit < runs.length ? items.at(-1).id : null });
  }
  if (request.method() === 'POST' && url.pathname.endsWith('/versions') && pendingSave) {
    pendingSave.started();
    await pendingSave.response;
  }
  return api.route(route);
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || message.text().includes('only supports one blocker')) errors.push(message.text());
});
const dialog = () => page.getByRole('dialog').last();
const keepEditing = () => page.getByRole('button', { name: '編集を続ける', exact: true });
const discard = () => page.getByRole('button', { name: '変更を破棄', exact: true });
const runLink = (taskIndex, runIndex) => page.getByRole('link', { name: `History ${taskIndex} Run ${runIndex}`, exact: true });
async function openCodeEditor(version) {
  await page.getByRole('heading', { name: 'Code', exact: true }).waitFor();
  await page.getByRole('button', { name: api.state.codeVersions[0].version, exact: true }).waitFor();
  await page.getByRole('button', { name: 'バージョンを作成', exact: true }).click();
  await dialog().getByLabel('バージョン').fill(version);
  const editor = dialog().getByRole('textbox', { name: 'コードエディタ: main.py', exact: true });
  await editor.focus();
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText('# kept navigation\n');
}
async function historyMove(method) {
  // Native back/forward events, without touching application state.
  await page.evaluate((action) => window.history[action](), method);
  await keepEditing().waitFor();
}
async function activateModelsLink() {
  // A modal makes the sidebar inert to pointer input; activate its real React link handler.
  await page.getByRole('link', { name: 'Models', exact: true }).evaluate((link) => link.click());
  await keepEditing().waitFor();
}
try {
  console.log('Navigation: browser back/forward retains edits until discard');
  await page.goto(projectBase + '/models');
  await page.getByRole('link', { name: 'Code', exact: true }).click();
  await openCodeEditor('unsaved-back');
  const codeUrl = page.url();
  await historyMove('back');
  await keepEditing().click();
  assert.equal(page.url(), codeUrl);
  assert.equal(await dialog().getByLabel('バージョン').inputValue(), 'unsaved-back');
  assert.ok((await dialog().locator('.view-lines').textContent()).replace(/\u00a0/g, ' ').includes('kept navigation'));
  await historyMove('back');
  await discard().click();
  await page.waitForURL(projectBase + '/models');
  await page.evaluate(() => window.history.forward());
  await page.waitForURL(projectBase + '/codes');
  await page.getByRole('heading', { name: 'Code', exact: true }).waitFor();
  await page.getByRole('button', { name: 'バージョンを作成', exact: true }).click();
  assert.equal(await dialog().getByLabel('バージョン').inputValue(), '');
  await dialog().getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await page.evaluate(() => window.history.back());
  await page.waitForURL(projectBase + '/codes');
  await openCodeEditor('unsaved-forward');
  await historyMove('forward');
  await keepEditing().click();
  assert.equal(await dialog().getByLabel('バージョン').inputValue(), 'unsaved-forward');
  await historyMove('forward');
  await discard().click();
  await page.waitForURL(projectBase + '/models');

  console.log('Navigation: sidebar links share the discard confirmation');
  await page.getByRole('link', { name: 'Code', exact: true }).click();
  await openCodeEditor('unsaved-link');
  await activateModelsLink();
  await keepEditing().click();
  assert.equal(await dialog().getByLabel('バージョン').inputValue(), 'unsaved-link');
  await activateModelsLink();
  await discard().click();
  await page.waitForURL(projectBase + '/models');

  console.log('Navigation: pending save completes before browser back');
  await page.getByRole('link', { name: 'Code', exact: true }).click();
  await openCodeEditor('saving-back');
  let releaseSave;
  let notifySaveStarted;
  const response = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { notifySaveStarted = resolve; });
  pendingSave = { started: notifySaveStarted, response };
  const previousVersionCount = api.state.codeVersions.length;
  await dialog().getByTestId('code-version-save').click();
  await saveStarted;
  const restoredLocation = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame === page.mainFrame() && frame.url() === codeUrl,
  });
  await page.evaluate(() => window.history.back());
  await restoredLocation;
  assert.equal(await dialog().getByTestId('code-version-save').isDisabled(), true);
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(api.state.codeVersions.length, previousVersionCount);
  releaseSave();
  await page.waitForURL(projectBase + '/models');
  await page.getByRole('heading', { name: 'Models', exact: true }).waitFor();
  assert.equal(api.state.codeVersions.length, previousVersionCount + 1);
  assert.ok(api.state.codeVersions.find((version) => version.version === 'saving-back').source.files['main.py'].includes('kept navigation'));
  pendingSave = null;

  console.log('History: older/latest pages, current-page polling and task reset');
  await page.goto(projectBase + `/tasks?id=${tasks[0].id}`);
  await runLink(1, 1).waitFor();
  await page.getByTestId('task-history-older').click();
  await runLink(1, 51).waitFor();
  const firstPageRequests = historyRequests.filter((entry) => entry.taskId === tasks[0].id && !entry.cursor).length;
  const olderCursor = new URL(page.url()).searchParams.get('historyCursor');
  await page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === `${taskPath}/${tasks[0].id}/runs` && url.searchParams.get('cursor') === olderCursor;
  });
  assert.equal(historyRequests.filter((entry) => entry.taskId === tasks[0].id && !entry.cursor).length, firstPageRequests);
  assert.equal(await page.getByTestId('task-history-older').isDisabled(), true);
  assert.equal(await runLink(1, 51).getAttribute('href'), `/projects/${api.state.project.id}/runs/${histories.get(tasks[0].id)[50].id}`);
  await page.getByRole('button', { name: tasks[1].name, exact: true }).click();
  await runLink(2, 1).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('historyCursor'), false);
  await page.getByTestId('task-history-older').click();
  await runLink(2, 51).waitFor();
  await page.getByTestId('task-history-latest').click();
  await runLink(2, 1).waitFor();
  await page.evaluate(() => window.history.back());
  await runLink(2, 51).waitFor();

  console.log('Navigation: nested Task/Workspace protects parent edits and same-page history');
  await page.getByRole('button', { name: 'Taskを編集', exact: true }).click();
  await dialog().getByLabel('名前').fill('unsaved-task-name');
  await dialog().getByTestId('task-edit-code').click();
  await historyMove('back');
  await keepEditing().click();
  assert.equal(await page.getByTestId('task-edit-form').getByLabel('名前').inputValue(), 'unsaved-task-name');
  await dialog().getByLabel('バージョン').fill('nested-unsaved');
  await historyMove('back');
  await keepEditing().click();
  assert.equal(await dialog().getByLabel('バージョン').inputValue(), 'nested-unsaved');
  await historyMove('back');
  await discard().click();
  await runLink(2, 1).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Same-page navigation retained discarded editor state');
  assert.equal(new URL(page.url()).searchParams.has('historyCursor'), false);
  await page.getByTestId('task-history-older').click();
  await runLink(2, 51).waitFor();
  await page.getByLabel('Experiments', { exact: true }).selectOption(api.state.experiments[0].id);
  await runLink(1, 1).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('historyCursor'), false);
  assert.equal(new URL(page.url()).searchParams.has('id'), false);
  assert.deepEqual(errors, []);
  console.log('Navigation and task history browser checks passed.');
} catch (error) {
  console.error('Navigation failure context:', JSON.stringify({ errors, url: page.url(), headings: await page.getByRole('heading').allTextContents() }));
  throw error;
} finally {
  await browser.close();
}
