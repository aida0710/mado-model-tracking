import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const api = createBrowserApi();
// Repeat quick switches to catch model events arriving with the previous file's listener.
const RAPID_FILE_SWITCH_COUNT = 3;
api.state.loggedIn = true;
const commit = 'a'.repeat(40);
api.state.codeVersions[0].source = { kind: 'git', url: 'https://example.invalid/code.git', commit,
  files: { 'main.py': 'print("overlay")\n' }, deletedFiles: ['old.py'] };
api.state.codeVersions[0].testEntrypoint = ['python', '-m', 'unittest'];
const tasks = [];
const controls = { failSave: false, failRepository: false, failTaskRevision: false, failTarget: false };
let sequence = 9000;
const identifier = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const now = '2026-10-08T04:00:00Z';
await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method();
  const body = request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : {};
  const reply = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  const parts = path.split('/').slice(3);
  if (path.endsWith('/repository-files')) {
    if (controls.failRepository) return reply({ error: 'repository unavailable' }, 503);
    return reply({ commit: body.commit, files: { 'main.py': 'print("base")\n', 'src/keep.py': 'print("keep")\n',
      'delete.py': 'print("delete")\n', 'old.py': 'print("old")\n' }, omittedPaths: ['weights.bin'] });
  }
  if (parts[0] === 'tasks') {
    api.state.calls.push({ method, path, body });
    if (parts.length === 1 && method === 'GET') return reply({ items: tasks });
    if (parts.length === 1 && method === 'POST') {
      const task = { ...body, id: identifier(), projectId: api.state.project.id, revision: 1, createdAt: now, updatedAt: now };
      tasks.push(task);
      return reply(task, 201);
    }
    const task = tasks.find((item) => item.id === parts[1]);
    if (method === 'PATCH') {
      if (body.expectedRevision !== task.revision || controls.failTaskRevision)
        return reply({ error: 'Task revision changed' }, 409);
      const { expectedRevision: _expectedRevision, ...changes } = body;
      Object.assign(task, changes, { revision: task.revision + 1 });
      return reply(task);
    }
    if (parts[2] === 'runs') return reply({ items: api.state.runs.filter((run) => run.taskId === task.id), nextCursor: null });
    if (parts[2] === 'launch') {
      if (body.expectedRevision !== task.revision || controls.failTaskRevision)
        return reply({ error: 'Task revision changed' }, 409);
      const code = api.state.codeVersions.find((version) => version.id === task.codeVersionId);
      const run = { ...api.state.runs[0], id: identifier(), name: body.name, status: 'queued', taskId: task.id,
        taskRevision: task.revision, executionMode: body.executionMode, codeVersionId: code.id,
        modelVersionId: body.modelVersionId, inputDatasetVersionIds: body.inputDatasetVersionIds,
        parameters: { ...task.parameters, ...body.parameters },
        executionSnapshot: { codeVersionId: code.id, version: code.version, mode: body.executionMode,
          source: code.source, runtime: code.runtime, requirements: code.requirements, environment: code.environment,
          entrypoint: body.executionMode === 'test' ? code.testEntrypoint : code.entrypoint } };
      const job = { id: identifier(), projectId: api.state.project.id, runId: run.id, targetId: body.targetId,
        gpuIds: body.gpuIds, status: 'queued', maxAttempts: 3, attempt: 0, cancelRequested: false, createdAt: now };
      api.state.runs.push(run);
      api.state.jobs.push(job);
      api.state.artifacts.push(...['.mmt/source.zip', '.mmt/source-manifest.json'].map((artifactPath) => ({
        ...api.state.artifacts[0], id: identifier(), runId: run.id, path: artifactPath,
      })));
      return reply({ run, job }, 201);
    }
  }
  if (/^\/targets\/[^/]+$/.test(path) && method === 'PATCH') {
    if (controls.failTarget) return reply({ error: 'Compute target is busy' }, 409);
    api.state.calls.push({ method, path, body });
    const target = api.state.targets.find((item) => path.endsWith('/' + item.id));
    Object.assign(target, body);
    return reply(target);
  }
  if (parts[0] === 'plugins' && parts.length === 2 && method === 'PATCH') {
    api.state.calls.push({ method, path, body });
    if (!api.state.user.isAdmin) return reply({ error: 'Global admin required' }, 403);
    const plugin = api.state.plugins.find((item) => item.id === parts[1]);
    if ((body.baseUrl && body.baseUrl !== plugin.baseUrl) || (body.tokenEnv && body.tokenEnv !== plugin.tokenEnv)) plugin.manifest = null;
    Object.assign(plugin, body);
    return reply(plugin);
  }
  if (parts[0] === 'artifacts' && parts.length === 2 && method === 'GET')
    return reply(api.state.artifacts.find((artifact) => artifact.id === parts[1]));
  if (parts[0] === 'codes' && parts[2] === 'versions' && method === 'POST' && controls.failSave) {
    controls.failSave = false;
    return reply({ error: 'code save unavailable' }, 503);
  }
  return api.route(route);
});
const page = await context.newPage();
const pageErrors = [];
const remoteEditorRequests = [];
const editorRequests = [];
const workerUrls = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('request', (request) => {
  if (/cdn|jsdelivr|unpkg/.test(request.url())) remoteEditorRequests.push(request.url());
  if (/MonacoCodeEditor|monaco-editor/.test(request.url())) editorRequests.push(request.url());
});
page.on('worker', (worker) => workerUrls.push(worker.url()));
const projectBase = `${process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182'}/projects/${api.state.project.id}`;
const dialog = () => page.getByRole('dialog').last();
const fill = (label, value) => dialog().getByLabel(label).fill(value);
// getByLabel matches part of a label, and '版' is also in '編集元のコード版'; the exact accessible
// name tells the two apart (the label text with its required mark is '版 *', so exact getByLabel fails).
const versionField = () => dialog().getByRole('textbox', { name: '版', exact: true });
const clickSave = () => dialog().getByTestId('code-version-save').click();
try {
  console.log('Workbench: Git overlay, multiple files, save failure and immutable version');
  await page.goto(projectBase + '/codes');
  await page.getByRole('heading', { name: 'Code', exact: true }).waitFor();
  assert.equal(editorRequests.length, 0, 'Monaco loaded before opening the editor');
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  await versionField().fill('edited-v2');
  controls.failRepository = true;
  await dialog().getByTestId('repository-load').click();
  await dialog().getByRole('alert').filter({ hasText: 'repository unavailable' }).waitFor();
  controls.failRepository = false;
  await dialog().getByTestId('repository-load').click();
  await dialog().getByRole('button', { name: 'ファイル: src/keep.py', exact: true }).waitFor();
  await dialog().getByRole('button', { name: 'ファイル: delete.py', exact: true }).click();
  await dialog().getByRole('button', { name: '選択したファイルを削除', exact: true }).click();
  await fill('ファイルのパス', 'delete.py/main.py');
  await dialog().getByRole('button', { name: 'ファイルを追加', exact: true }).click();
  const versionCount = api.state.codeVersions.length;
  await clickSave();
  await dialog().getByRole('alert').filter({ hasText: '同じパスまたは親子が衝突' }).waitFor();
  assert.equal(api.state.codeVersions.length, versionCount, 'A conflicting Git overlay reached the API');
  assert.equal(await dialog().getByTestId('active-file').textContent(), 'delete.py/main.py');
  await dialog().getByRole('button', { name: '選択したファイルを削除', exact: true }).click();
  await fill('ファイルのパス', 'src/new.py');
  await dialog().getByRole('button', { name: 'ファイルを追加', exact: true }).click();
  await dialog().locator('.monaco-editor').waitFor();
  const editor = dialog().getByRole('textbox', { name: 'コードエディタ: src/new.py', exact: true });
  await editor.focus();
  await page.keyboard.insertText('print("new")\n');
  await dialog().getByRole('button', { name: 'ファイル: main.py', exact: true }).click();
  const mainEditor = dialog().getByRole('textbox', { name: 'コードエディタ: main.py', exact: true });
  await mainEditor.focus();
  await mainEditor.press('ControlOrMeta+End');
  await page.keyboard.insertText('# main edit\n');
  await dialog().getByRole('button', { name: 'ファイル: src/new.py', exact: true }).click();
  await editor.focus();
  await editor.press('ControlOrMeta+z');
  await editor.press('ControlOrMeta+Shift+z');
  await dialog().getByLabel('リポジトリの選択').selectOption('other');
  await fill('Git URL', 'https://example.invalid/other.git');
  await fill('Commit', 'b'.repeat(40));
  await clickSave();
  await dialog().getByRole('alert').filter({ hasText: '新しいGitのファイルを読み込んでください' }).waitFor();
  await dialog().getByTestId('repository-load').click();
  await dialog().getByRole('button', { name: 'ファイル: src/new.py', exact: true }).waitFor();
  await dialog().getByLabel('リポジトリの選択').selectOption('same');
  assert.equal(await dialog().getByLabel('Git URL').inputValue(), 'https://example.invalid/code.git');
  await dialog().getByTestId('repository-load').click();
  controls.failSave = true;
  await clickSave();
  await dialog().getByRole('alert').filter({ hasText: 'code save unavailable' }).waitFor();
  assert.equal(await versionField().inputValue(), 'edited-v2');
  await clickSave();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const edited = api.state.codeVersions.find((version) => version.version === 'edited-v2');
  assert.deepEqual(edited.source.files, { 'main.py': 'print("overlay")\n# main edit\n', 'src/new.py': 'print("new")\n' });
  assert.deepEqual(edited.source.deletedFiles, ['delete.py', 'old.py']);
  assert.equal(api.state.codeVersions[0].source.files['main.py'], 'print("overlay")\n');
  assert.equal(api.state.codeVersions[0].version, 'v1');
  assert.equal(api.state.codeVersions[0].source.deletedFiles.length, 1);

  console.log('Workbench: unsaved changes and mobile modal');
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  await versionField().fill('discard-me');
  await dialog().getByRole('button', { name: '閉じる', exact: true }).click();
  await dialog().getByRole('button', { name: '編集を続ける', exact: true }).click();
  assert.equal(await versionField().inputValue(), 'discard-me');
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog().boundingBox();
  assert.ok(bounds.width <= 390 && bounds.x >= 0, 'workspace modal overflows the mobile viewport');
  await dialog().getByRole('button', { name: 'キャンセル', exact: true }).click();
  await dialog().getByRole('button', { name: '変更を破棄', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 960 });

  console.log('Workbench: standalone samples and test command');
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  await dialog().getByLabel('編集元のコード版').selectOption('');
  await versionField().fill('smoke-v3');
  await dialog().getByLabel('リポジトリの選択').selectOption('standalone');
  await dialog().getByLabel('サンプル').selectOption('sdk');
  await dialog().getByRole('button', { name: 'サンプルを追加', exact: true }).click();
  await dialog().getByRole('button', { name: 'ファイル: test_smoke.py', exact: true }).waitFor();
  const sampleEditor = dialog().getByRole('textbox', { name: 'コードエディタ: main.py', exact: true });
  await sampleEditor.focus();
  await sampleEditor.press('ControlOrMeta+Home');
  await page.keyboard.insertText('# edited main sample\n');
  await fill('ファイルのパス', 'notes.md');
  await dialog().getByRole('button', { name: 'ファイルを追加', exact: true }).click();
  await dialog().getByRole('button', { name: 'ファイル: notes.md', exact: true }).click();
  const notesEditor = dialog().getByRole('textbox', { name: 'コードエディタ: notes.md', exact: true });
  await notesEditor.focus();
  await notesEditor.press('ControlOrMeta+Home');
  await notesEditor.press('ControlOrMeta+Shift+End');
  await page.keyboard.insertText('# experiment notes\n');
  for (let switchCount = 0; switchCount < RAPID_FILE_SWITCH_COUNT; switchCount++) {
    await dialog().getByRole('button', { name: 'ファイル: main.py', exact: true }).click();
    await dialog().getByRole('button', { name: 'ファイル: notes.md', exact: true }).click();
  }
  await dialog().getByRole('button', { name: 'ファイル: main.py', exact: true }).click();
  await fill('対応モデル系列（1行に1件）', 'test-family');
  await dialog().getByLabel('対応する実行種別').selectOption(['inference', 'training']);
  await clickSave();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const smoke = api.state.codeVersions.find((version) => version.version === 'smoke-v3');
  assert.equal(smoke.source.kind, 'inline');
  assert.ok(smoke.source.files['main.py'].startsWith('# edited main sample\n'), 'Switching files lost the edited main.py');
  assert.ok(smoke.source.files['main.py'].includes('run.log_metrics'));
  assert.equal(smoke.source.files['notes.md'], '# experiment notes\n');
  assert.deepEqual(smoke.testEntrypoint, ['python', '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py']);

  console.log('Workbench: Task create, edit code version, exact revision/test launch/history');
  await page.goto(projectBase + '/tasks');
  await page.getByRole('button', { name: 'Taskを作成', exact: true }).click();
  await fill('名前', 'Browser Task');
  await dialog().getByLabel('コード版').selectOption(smoke.id);
  await dialog().getByLabel('Compute target').selectOption(api.state.targets[0].id);
  await dialog().getByLabel('GPU ID', { exact: true }).selectOption([]);
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByTestId('task-revision').getByText('1', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Taskを編集', exact: true }).click();
  await dialog().getByTestId('task-edit-code').click();
  await versionField().fill('task-code-v4');
  await clickSave();
  await dialog().getByLabel('コード版').locator('option:checked').getByText(/task-code-v4/).waitFor({ state: 'attached' });
  const taskCode = api.state.codeVersions.find((version) => version.version === 'task-code-v4');
  assert.equal(await dialog().getByLabel('コード版').inputValue(), taskCode.id);
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByTestId('task-revision').getByText('2', { exact: true }).waitFor();
  await page.getByTestId('task-launch-test').click();
  controls.failTaskRevision = true;
  await dialog().getByRole('button', { name: 'テスト実行', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: 'Task revision changed' }).waitFor();
  assert.equal(api.state.runs.filter((run) => run.taskId).length, 0);
  controls.failTaskRevision = false;
  await dialog().getByRole('button', { name: 'テスト実行', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const run = api.state.runs.find((item) => item.taskId);
  assert.equal(run.taskRevision, 2);
  assert.equal(run.executionMode, 'test');
  assert.equal(run.codeVersionId, taskCode.id);
  await page.getByRole('link', { name: 'Browser Task', exact: true }).click();
  await page.getByRole('tab', { name: '実行snapshot', exact: true }).click();
  await page.getByTestId('snapshot-command').waitFor();
  assert.ok((await page.getByTestId('snapshot-command').textContent()).includes('unittest'));
  await page.getByRole('link', { name: '.mmt/source.zip', exact: true }).waitFor();
  await page.getByRole('link', { name: '.mmt/source-manifest.json', exact: true }).waitFor();
  await page.goto(projectBase + '/tasks');
  await page.getByTestId('task-launch-run').click();
  await dialog().getByRole('button', { name: '通常実行', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const normalRun = api.state.runs.find((item) => item.taskId && item.executionMode === 'run');
  assert.deepEqual(normalRun.executionSnapshot.entrypoint, smoke.entrypoint);
  assert.equal(normalRun.taskRevision, 2);

  console.log('Workbench: Compute edit/toggle with failure, plugin preset/edit/toggle/manifest');
  await page.goto(projectBase + '/compute');
  await page.getByRole('button', { name: '計算機を編集', exact: true }).click();
  assert.equal(await dialog().getByLabel('GPU ID（1行に1件）').inputValue(), '0\n1');
  await fill('名前', 'Edited Compute');
  controls.failTarget = true;
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: 'Compute target is busy' }).waitFor();
  controls.failTarget = false;
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('checkbox', { name: 'Compute targetを無効にする: Edited Compute', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Compute targetを有効にする: Edited Compute', exact: true }).waitFor();
  assert.deepEqual(api.state.calls.filter((call) => call.method === 'PATCH' && call.path.includes('/targets/')).at(-1).body, { enabled: false });
  await page.goto(projectBase + '/plugins');
  await page.getByRole('button', { name: 'Pluginを編集', exact: true }).click();
  await dialog().getByRole('button', { name: 'Madoの設定例を使う', exact: true }).click();
  assert.equal(await dialog().getByLabel('接続先URL').inputValue(), 'http://127.0.0.1:4190');
  assert.equal(await dialog().getByLabel('トークンを参照する環境変数名').inputValue(), 'MMT_MADO_PLUGIN_TOKEN');
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '接続を確認', exact: true }).click();
  await page.getByText('接続を確認しました', { exact: true }).waitFor();
  await page.locator('.plugin-manifest summary').click();
  assert.ok((await page.locator('.plugin-manifest pre').textContent()).includes('capabilities'));
  await page.getByTestId('plugin-toggle').click();
  await page.getByRole('button', { name: 'Pluginを有効にする', exact: true }).waitFor();
  assert.deepEqual(api.state.calls.filter((call) => call.method === 'PATCH' && call.path.includes('/plugins/')).at(-1).body, { enabled: false });
  api.state.user.isAdmin = false;
  await page.reload();
  await page.getByRole('button', { name: '接続を確認', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Pluginを編集', exact: true }).count(), 0);
  assert.equal(await page.getByTestId('plugin-toggle').count(), 0);
  api.state.project.role = 'viewer';
  await page.goto(projectBase + '/tasks');
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Taskを作成', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Taskを編集', exact: true }).count(), 0);
  assert.equal(await page.getByTestId('task-launch-test').count(), 0);
  assert.deepEqual(remoteEditorRequests, []);
  assert.ok(workerUrls.length > 0, 'Monaco did not create a worker');
  assert.ok(workerUrls.every((url) => url.startsWith(new URL(projectBase).origin) || url.startsWith('blob:' + new URL(projectBase).origin)), 'Monaco used a remote worker');
  assert.deepEqual(pageErrors, []);
  console.log('Workbench browser checks passed.');
} finally { await browser.close(); }
