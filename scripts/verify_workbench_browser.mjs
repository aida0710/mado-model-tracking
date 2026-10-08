/** Exercise the real workbench UI, CPU worker and local HTTP plugin. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('MMT_PLAYWRIGHT_MODULE is required');
const { chromium } = await import(pathToFileURL(modulePath).href);
const base = process.env.MMT_WEB_URL ?? 'http://10.0.10.160:5182';
const verificationDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const artifactDirectory = `artifacts/verification/${verificationDate}/workbench`;
const summaryPath = `${artifactDirectory}/playground.json`;
const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
const projectBase = `${base}/projects/${summary.projectId}`;
const projectApi = `projects/${summary.projectId}`;
// Compute names are global; separate Playground projects need separate target names.
const playgroundTargetName = `Playground CPU ${summary.projectId.slice(0, 8)}`;
// Real venv setup and Git fetching are bounded independently by the worker and API.
const JOB_DEADLINE_MS = 120_000;
const JOB_POLL_MS = 250;
const SERVICE_TOKEN_DAYS = 7;
// The sample's final input is 3: changing its coefficient from 2 to 3 changes 7 to 10.
const SDK_LAST_VALUE_V1 = 7;
const SDK_LAST_VALUE_V2 = 10;
const pythonExecutable = path.resolve('python/.venv/bin/python');
const repositoryUrl = 'https://github.com/octocat/Hello-World.git';
const repositoryCommit = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
const editorRequests = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('request', (request) => {
  if (/cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare/.test(request.url())) editorRequests.push(request.url());
});
const dialog = () => page.getByRole('dialog').last();
const field = (label) => {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return dialog().getByLabel(new RegExp('^' + escapedLabel + '(?: \\*)?$'));
};

async function api(method, resource, body) {
  const response = await page.request.fetch(`${base}/api/${resource}`, {
    method, headers: { Origin: base }, ...(body === undefined ? {} : { data: body }),
  });
  assert.ok(response.ok(), `${method} ${resource}: HTTP ${response.status()}`);
  return response.json();
}

async function saveEntity({ method, resource, click }) {
  const requested = page.waitForResponse((response) =>
    response.url().includes(`/api/${resource}`) && response.request().method() === method,
  );
  await click();
  const response = await requested;
  assert.ok(response.ok(), `${method} ${resource}: HTTP ${response.status()}`);
  return response.json();
}

async function replaceEditorFile({ filePath, content }) {
  await dialog().getByRole('button', { name: `ファイル: ${filePath}`, exact: true }).click();
  const textbox = dialog().getByRole('textbox', { name: `コードエディタ: ${filePath}`, exact: true });
  await textbox.focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+Shift+End');
  // Clipboard paste preserves a complete Python file's indentation; typing each newline auto-indents.
  await textbox.evaluate((element, text) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: clipboard, bubbles: true, cancelable: true,
    }));
  }, content);
}

async function createCode({ name, sample, sourceKind }) {
  const existingNames = new Set((await api('GET', `${projectApi}/codes`)).items.map((code) => code.name));
  let sequence = 1;
  const originalName = name;
  while (existingNames.has(name)) name = `${originalName} (${++sequence})`;
  await page.goto(`${projectBase}/codes`);
  await page.getByRole('button', { name: 'コードを登録', exact: true }).click();
  await field('名前').fill(name);
  const code = await saveEntity({ method: 'POST', resource: `${projectApi}/codes`,
    click: () => dialog().getByRole('button', { name: '保存', exact: true }).click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  if (sourceKind === 'git') {
    await field('Git URL').fill(repositoryUrl);
    await field('Commit').fill(repositoryCommit);
    await dialog().getByTestId('repository-load').click();
    await dialog().getByRole('button', { name: 'ファイル: README', exact: true }).waitFor();
    await replaceEditorFile({ filePath: 'README', content: '# Playgroundで編集したGitコード\n' });
  } else {
    await field('リポジトリの選択').selectOption('standalone');
  }
  await field('サンプル').selectOption(sample);
  await dialog().getByRole('button', { name: 'サンプルを追加', exact: true }).click();
  await field('Version').fill('v1');
  if (sourceKind === 'inline') {
    const textbox = dialog().getByRole('textbox', { name: 'コードエディタ: main.py', exact: true });
    await textbox.focus();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('# Playgroundで編集したコード\n');
    await field('ファイルのパス').fill('notes.md');
    await dialog().getByRole('button', { name: 'ファイルを追加', exact: true }).click();
    await replaceEditorFile({ filePath: 'notes.md', content: '# 実験メモ\nCPUでコードを編集して試すサンプル。\n' });
    await dialog().getByRole('button', { name: 'ファイル: main.py', exact: true }).click();
    await dialog().getByRole('textbox', { name: 'コードエディタ: main.py', exact: true }).waitFor();
    await page.screenshot({ path: `${artifactDirectory}/code-editor.png` });
  }
  const version = await saveEntity({ method: 'POST', resource: `${projectApi}/codes/${code.id}/versions`,
    click: () => dialog().getByTestId('code-version-save').click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(version.source.kind, sourceKind);
  assert.ok(version.testEntrypoint.length);
  if (sourceKind === 'inline') assert.ok(version.source.files['main.py'].startsWith('# Playgroundで編集'));
  else assert.equal(version.source.files.README, '# Playgroundで編集したGitコード\n');
  return { code, version };
}

async function createTask({ name, codeVersionId, targetId, kind = 'processing', modelVersionId }) {
  await page.goto(`${projectBase}/tasks`);
  await page.getByRole('button', { name: 'Taskを作成', exact: true }).click();
  await field('名前').fill(name);
  await field('実行種別').selectOption(kind);
  if (modelVersionId) await field('モデル版').selectOption(modelVersionId);
  await field('コード版').selectOption(codeVersionId);
  await field('Compute target').selectOption(targetId);
  const task = await saveEntity({ method: 'POST', resource: `${projectApi}/tasks`,
    click: () => dialog().getByRole('button', { name: '保存', exact: true }).click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  return task;
}

async function executeTask({ task, mode, name }) {
  await page.goto(`${projectBase}/tasks?id=${task.id}`);
  await page.getByTestId(mode === 'test' ? 'task-launch-test' : 'task-launch-run').click();
  await field('Run name').fill(name);
  const execution = await saveEntity({ method: 'POST', resource: `${projectApi}/tasks/${task.id}/launch`,
    click: () => dialog().getByRole('button', { name: mode === 'test' ? 'テスト実行' : '通常実行', exact: true }).click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const deadline = Date.now() + JOB_DEADLINE_MS;
  while (Date.now() < deadline) {
    const run = await api('GET', `${projectApi}/runs/${execution.run.id}`);
    if (['finished', 'failed', 'canceled'].includes(run.status)) {
      assert.equal(run.status, 'finished', `Sample execution ${run.id}: ${run.error ?? run.status}`);
      assert.equal(run.executionMode, mode);
      assert.equal(run.taskRevision, task.revision);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
  }
  throw new Error('The sample worker did not finish before its deadline');
}

async function startDevelopmentWorker(targetId) {
  const directory = path.resolve('var/playground');
  await mkdir(directory, { recursive: true });
  const settingsPath = path.join(directory, 'worker-settings.json');
  const pidPath = path.join(directory, 'worker.pid');
  try {
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (command.includes('scripts/serve_workbench_worker.py')) {
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.equal(settings.MMT_WORKER_TARGET_IDS, targetId);
      summary.workerPid = pid;
      return;
    }
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  const issued = await api('POST', 'tokens', {
    name: 'Playground CPU worker', kind: 'service', projectId: summary.projectId,
    scopes: ['read', 'runs:write', 'registry:write', 'artifacts:write', 'jobs:write', 'worker:execute'],
    expiresAt: new Date(Date.now() + SERVICE_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });
  await writeFile(settingsPath, JSON.stringify({
    MMT_API_URL: base, MMT_API_TOKEN: issued.token, MMT_WORKER_ID: `playground-${summary.projectId}`,
    MMT_WORKER_TARGET_IDS: targetId, MMT_WORKER_STATE_DIR: path.join(directory, 'state', summary.projectId),
    MMT_ALLOW_LOCAL_EXECUTOR: 'true',
  }, null, 2), { mode: 0o600 });
  await chmod(settingsPath, 0o600);
  const log = await open(path.join(directory, 'worker.log'), 'a', 0o600);
  const worker = spawn(pythonExecutable, ['scripts/serve_workbench_worker.py'], {
    cwd: process.cwd(), detached: true, env: { ...process.env, PYTHONPATH: path.resolve('python/src') },
    stdio: ['ignore', log.fd, log.fd],
  });
  await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
  worker.unref();
  await log.close();
  await writeFile(pidPath, String(worker.pid) + '\n');
  summary.workerPid = worker.pid;
  summary.workerTokenId = issued.item.id;
  summary.workerTokenExpiresAt = issued.item.expiresAt;
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
}

try {
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill('admin@localhost');
  await page.getByLabel('表示名').fill('開発管理者');
  await page.getByRole('button', { name: '開発モードでログイン', exact: true }).click();
  await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor();
  await page.getByRole('button', { name: 'ダークテーマ', exact: true }).click();
  await page.goto(`${projectBase}/compute`);
  let target = summary.targetId
    ? (await api('GET', 'targets')).items.find((item) => item.id === summary.targetId)
    : undefined;
  if (!target) {
  await page.getByRole('button', { name: 'Compute targetを登録', exact: true }).click();
  await field('名前').fill(playgroundTargetName);
  await field('Executor').selectOption('local');
  await field('Host').fill('127.0.0.1');
  await field('SSHユーザー').fill('local');
  await field('作業ディレクトリ').fill(path.resolve('var/playground/jobs'));
  await field('Python実行パス').fill(pythonExecutable);
  target = await saveEntity({ method: 'POST', resource: 'targets',
    click: () => dialog().getByRole('button', { name: '保存', exact: true }).click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  await page.getByTestId(`target-edit-${target.id}`).click();
  await field('同時実行数').fill('2');
  await saveEntity({ method: 'PATCH', resource: `targets/${target.id}`,
    click: () => dialog().getByRole('button', { name: '保存', exact: true }).click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('checkbox', { name: `Compute targetを無効にする: ${playgroundTargetName}`, exact: true }).click();
  await page.getByRole('checkbox', { name: `Compute targetを有効にする: ${playgroundTargetName}`, exact: true }).click();
  summary.targetId = target.id;
  await startDevelopmentWorker(target.id);

  const sdk = await createCode({ name: 'CPUメトリクス', sample: 'sdk', sourceKind: 'inline' });
  let task = await createTask({ name: 'メトリクスを記録', codeVersionId: sdk.version.id, targetId: target.id });
  const firstTest = await executeTask({ task, mode: 'test', name: 'SDK v1のテスト' });
  const firstRun = await executeTask({ task, mode: 'run', name: 'SDK v1の通常実行' });
  await page.getByRole('button', { name: 'Taskを編集', exact: true }).click();
  await dialog().getByTestId('task-edit-code').click();
  await field('Version').fill('v2');
  await replaceEditorFile({ filePath: 'main.py', content: sdk.version.source.files['main.py'].replace('2.0 * value + 1.0', '3.0 * value + 1.0') });
  await replaceEditorFile({ filePath: 'test_smoke.py', content: sdk.version.source.files['test_smoke.py'].replace('7.0', '10.0') });
  const secondCode = await saveEntity({ method: 'POST', resource: `${projectApi}/codes/${sdk.code.id}/versions`,
    click: () => dialog().getByTestId('code-version-save').click() });
  assert.equal(secondCode.source.files['main.py'], sdk.version.source.files['main.py'].replace('2.0 * value + 1.0', '3.0 * value + 1.0'));
  assert.equal(secondCode.source.files['test_smoke.py'], sdk.version.source.files['test_smoke.py'].replace('7.0', '10.0'));
  await field('コード版').locator('option:checked').getByText(/v2/).waitFor({ state: 'attached' });
  task = await saveEntity({ method: 'PATCH', resource: `${projectApi}/tasks/${task.id}`,
    click: () => dialog().getByRole('button', { name: '保存', exact: true }).click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const secondTest = await executeTask({ task, mode: 'test', name: 'SDK v2のテスト' });
  const secondRun = await executeTask({ task, mode: 'run', name: 'SDK v2の通常実行' });
  assert.equal(firstRun.codeVersionId, sdk.version.id);
  assert.equal(secondRun.codeVersionId, secondCode.id);
  assert.equal(firstRun.latestMetrics['sample.value'], SDK_LAST_VALUE_V1);
  assert.equal(secondRun.latestMetrics['sample.value'], SDK_LAST_VALUE_V2);
  await page.goto(`${projectBase}/runs/${secondRun.id}?tab=executionSnapshot`);
  await page.getByTestId('run-execution-snapshot').waitFor();
  await page.getByTestId('snapshot-command').waitFor();
  const snapshots = (await api('GET', `${projectApi}/runs/${secondRun.id}/artifacts`)).items;
  assert.ok(snapshots.some((artifact) => artifact.path === '.mmt/source.zip'));
  await page.goto(`${projectBase}/tasks?id=${task.id}`);
  await page.getByRole('link', { name: 'SDK v1のテスト', exact: true }).waitFor();
  await page.getByRole('link', { name: 'SDK v2の通常実行', exact: true }).waitFor();
  await page.screenshot({ path: `${artifactDirectory}/task-history.png` });

  await page.goto(`${projectBase}/plugins`);
  await page.getByRole('button', { name: 'Pluginを登録', exact: true }).click();
  await dialog().getByRole('button', { name: 'Madoの設定例を使う', exact: true }).click();
  await field('名前').fill('Mado接続の検証（fixture）');
  await field('接続先URL').fill('http://127.0.0.1:4195');
  await field('トークンを参照する環境変数名').fill('MMT_WORKBENCH_PLUGIN_TOKEN');
  const plugin = await saveEntity({ method: 'POST', resource: `${projectApi}/plugins`,
    click: () => dialog().getByRole('button', { name: '保存', exact: true }).click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '接続を確認', exact: true }).click();
  await page.getByText('接続を確認しました', { exact: true }).waitFor();
  await page.getByTestId('plugin-toggle').click();
  await page.getByRole('button', { name: 'Pluginを有効にする', exact: true }).click();
  await page.getByRole('button', { name: 'Pluginを編集', exact: true }).click();
  await field('名前').fill('Mado HTTP fixture');
  await saveEntity({ method: 'PATCH', resource: `${projectApi}/plugins/${plugin.id}`,
    click: () => dialog().getByRole('button', { name: '保存', exact: true }).click() });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.getByRole('button', { name: 'インポート', exact: true }).click();
  await page.getByText('workbench-fixture/CPUサンプルの入力', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Local fixture', exact: true }).waitFor();
  await page.getByRole('cell', { name: 'samples', exact: true }).waitFor();
  await page.screenshot({ path: `${artifactDirectory}/plugin-manager.png` });

  const git = await createCode({ name: 'Gitサンプル', sample: 'smoke', sourceKind: 'git' });
  const gitTask = await createTask({ name: 'Gitのスモークテスト', codeVersionId: git.version.id, targetId: target.id });
  const gitTest = await executeTask({ task: gitTask, mode: 'test', name: 'Git commitと編集差分のテスト' });
  assert.equal(gitTest.executionSnapshot.source.commit, repositoryCommit);

  const training = await createCode({ name: 'CPU学習', sample: 'training', sourceKind: 'inline' });
  const trainingTask = await createTask({ name: 'CPUで学習してモデルを登録',
    codeVersionId: training.version.id, targetId: target.id, kind: 'training' });
  const trainingTest = await executeTask({ task: trainingTask, mode: 'test', name: '学習コードのテスト' });
  const trainingRun = await executeTask({ task: trainingTask, mode: 'run', name: 'CPU学習とモデル登録' });
  const trainedModel = (await api('GET', `${projectApi}/models`)).items.find(
    (model) => model.name === `sample-linear-${trainingRun.id}`,
  );
  assert.ok(trainedModel, 'The training sample did not register its output model');
  const trainedVersion = (await api('GET', `${projectApi}/models/${trainedModel.id}/versions`)).items.find(
    (version) => version.sourceRunId === trainingRun.id,
  );
  assert.ok(trainedVersion, 'The trained ModelVersion does not refer to its generating Run');
  const modelVersionId = trainedVersion.id;
  const trainingMetrics = (await api('GET', `${projectApi}/runs/${trainingRun.id}/metrics`)).items;
  const losses = trainingMetrics.filter((point) => point.name === 'train.loss');
  assert.ok(losses.length > 1 && losses.at(-1).value < losses[0].value);

  const inference = await createCode({ name: 'CPU推論', sample: 'inference', sourceKind: 'inline' });
  const inferenceTask = await createTask({ name: '登録モデルを別の推論コードで実行',
    codeVersionId: inference.version.id, targetId: target.id, kind: 'inference', modelVersionId });
  const inferenceRun = await executeTask({ task: inferenceTask, mode: 'run', name: '学習済みモデルのCPU推論' });
  const predictions = (await api('GET', `${projectApi}/runs/${inferenceRun.id}/artifacts`)).items;
  const predictionArtifact = predictions.find((artifact) => artifact.path === 'inference/predictions.json');
  assert.ok(predictionArtifact);
  assert.ok(trainedVersion.artifactId);
  const savedWeights = await api('GET', `${projectApi}/artifacts/${trainedVersion.artifactId}/content`);
  const savedPredictions = await api('GET', `${projectApi}/artifacts/${predictionArtifact.id}/content`);
  assert.deepEqual(savedPredictions, [0, 1, 2].map((value) => ({
    x: value, prediction: savedWeights.weight * value + savedWeights.bias,
  })));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(editorRequests, []);
  Object.assign(summary, {
    origin: base, sdkCodeId: sdk.code.id, sdkCodeVersionIds: [sdk.version.id, secondCode.id],
    taskId: task.id, taskRevision: task.revision, gitTaskId: gitTask.id, pluginId: plugin.id,
    trainingTaskId: trainingTask.id, inferenceTaskId: inferenceTask.id, modelVersionId,
    runIds: [firstTest.id, firstRun.id, secondTest.id, secondRun.id, gitTest.id,
      trainingTest.id, trainingRun.id, inferenceRun.id],
    checks: ['Compute creation, edit and enable toggle', 'real Monaco input and saved files',
      'standalone sample, test and real SDK metrics', 'Task editor saves and selects a new code version',
      'previous Task revisions retain their code', 'Run execution snapshot and worker source ZIP',
      'plugin preset, registration, manifest, metrics, edit, toggle and dataset import',
      'real Git preview, saved edits and worker test',
      'training sample registers a model used by a separate inference Task',
      'LAN Origin', 'no remote editor CDN or browser exceptions'],
  });
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  await writeFile(`${artifactDirectory}/browser-integration.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally { await browser.close(); }
