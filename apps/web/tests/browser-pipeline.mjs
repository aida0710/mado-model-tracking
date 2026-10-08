/**
 * Drives the whole pipeline through the real Web UI against a real API in local login mode:
 * local login and the forced password change, the storage connection test, Project creation,
 * code versions, automation rules, a promotion policy, a training Task with an output model, a
 * CPU worker, the model version page (inference, evaluation, metrics, baseline comparison),
 * promotion with a reason, the alias history, and a viewer (through a group binding) who cannot
 * operate.
 *
 * It starts its own server (tests/fixtures/pipeline/serve.ts: a fresh test schema in
 * MMT_TEST_DATABASE_URL and the built Web app on one port) and a worker process, and stops both.
 * Waits poll the text on screen; there are no fixed sleeps. Build the Web app first
 * (`npm run build -w @mmt/web`).
 *
 * Environment: MMT_PLAYWRIGHT_MODULE, MMT_CHROMIUM_PATH, MMT_TEST_DATABASE_URL, optional
 * MMT_SCREENSHOT_DIR and MMT_PIPELINE_PORT (47002).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openProjectCreation } from './projectCreation.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const EXAMPLES = path.join(ROOT, 'python/examples');
const PYTHON = path.join(ROOT, 'python/.venv/bin/python');
const WORKER = path.join(ROOT, 'python/.venv/bin/mado-tracking-worker');
// Verification servers started by agents use 47000-47009; the running Web is 5182.
const PORT = Number(process.env.MMT_PIPELINE_PORT ?? 47002);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_START_MS = 90_000;
// A Job installs httpx into a fresh venv before the example runs.
const JOB_MS = 180_000;
// How often a wait re-reads a page that does not poll by itself.
const SCREEN_POLL_MS = 1_000;
const MODEL_FAMILY = 'linear';
const MODEL_NAME = 'browser-linear';
const PROMOTION_ALIAS = 'production';
const users = JSON.parse(await readFile(new URL('./fixtures/pipeline/users.json', import.meta.url), 'utf8'));
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const reportDirectory = path.join(ROOT, 'artifacts/verification', today, 'pipeline');
const workDirectory = path.join(ROOT, 'var/verification-browser-pipeline', `${Date.now()}`);
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
// Generated per run and handed to the server through its environment; never printed.
const passwords = {
  admin: randomBytes(12).toString('hex'),
  adminChanged: randomBytes(12).toString('hex'),
  viewer: randomBytes(12).toString('hex'),
};

// The inference outputs (WAV lengths) for x = 0, 1, 2 on y = 2x + 1.
const referenceSamples = [0, 1, 2].map((x, index) => ({
  audio: `sample-${String(index).padStart(3, '0')}.wav`,
  durationSeconds: Math.round((2 * x + 1) * 0.1 * 1e6) / 1e6,
}));

const stages = [];
async function stage(name, description, check) {
  const record = { name, description, status: 'running' };
  stages.push(record);
  const started = performance.now();
  try {
    record.details = (await check()) ?? {};
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    await screenshot(`failed-${name}`).catch(() => {});
    throw error;
  } finally {
    record.seconds = Math.round(performance.now() - started) / 1000;
    console.log(`${record.status.padStart(8)}  ${String(record.seconds).padStart(8)}  ${name}`);
  }
}

function startProcess(command, args, { env, logName }) {
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, detached: true });
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk));
  child.stderr.on('data', (chunk) => log.push(chunk));
  child.logName = logName;
  child.log = log;
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  process.kill(-child.pid, 'SIGTERM');
  const timeout = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 30_000);
  await exited;
  clearTimeout(timeout);
  await writeFile(path.join(reportDirectory, child.logName), Buffer.concat(child.log));
}

async function waitForServer() {
  const deadline = Date.now() + SERVER_START_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('The verification server exited early');
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The verification server did not start within ${SERVER_START_MS} ms`);
}

await mkdir(reportDirectory, { recursive: true });
await mkdir(workDirectory, { recursive: true });
const server = startProcess(
  path.join(ROOT, 'node_modules/.bin/tsx'),
  ['apps/web/tests/fixtures/pipeline/serve.ts'],
  {
    env: {
      MMT_PIPELINE_PORT: String(PORT),
      MMT_PIPELINE_ADMIN_PASSWORD: passwords.admin,
      MMT_PIPELINE_VIEWER_PASSWORD: passwords.viewer,
    },
    logName: 'browser-pipeline-server.log',
  },
);
let worker;
const { chromium } = await import(pathToFileURL(process.env.MMT_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.MMT_CHROMIUM_PATH,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const dialog = () => page.getByRole('dialog');

async function screenshot(name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true });
}

// Setup that has no screen for the local executor (Compute offers it only in development mode).
async function api(method, resource, body) {
  const response = await page.request.fetch(`${BASE}/api${resource}`, {
    method,
    headers: { Origin: BASE, 'Content-Type': 'application/json' },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok(), `${method} ${resource}: HTTP ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}

/** Wait until `locator` shows, pressing the page's reload button between looks. */
async function waitOnScreen(locator, { timeout = JOB_MS, reload } = {}) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: SCREEN_POLL_MS });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      if (reload) await reload();
    }
  }
}

async function login(username, password) {
  await page.goto(BASE);
  await page.getByLabel('ユーザー名').fill(username);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'ローカルアカウントでログイン' }).click();
}

async function logout() {
  await page.request.post(`${BASE}/api/auth/logout`, { headers: { Origin: BASE } });
  await page.context().clearCookies();
}

/**
 * Paste text the way a user pastes a file into the code editor. Typing it (keyboard.insertText)
 * would let the editor auto-indent every new line and change the Python source.
 */
async function pasteIntoFocusedEditor(content) {
  await page.evaluate((text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    document.activeElement.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  }, content);
}

async function addCodeVersion({ name, version, files, entrypoint, taskType }) {
  await page.goto(`${projectBase}/codes`);
  await page.getByRole('button', { name: 'コードを登録', exact: true }).click();
  await dialog().getByLabel('名前', { exact: false }).fill(name);
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  await dialog().getByLabel('Version', { exact: false }).fill(version);
  await dialog().getByLabel('ソース形式', { exact: false }).selectOption('inline');
  for (const [fileName, content] of Object.entries(files)) {
    await dialog().getByLabel('ファイルのパス', { exact: false }).fill(fileName);
    await dialog().getByRole('button', { name: 'ファイルを追加', exact: true }).click();
    await dialog().getByRole('textbox', { name: `コードエディタ: ${fileName}`, exact: true }).focus();
    await pasteIntoFocusedEditor(content);
  }
  await dialog().getByLabel('実行コマンド', { exact: false }).fill(JSON.stringify(entrypoint));
  await dialog().getByLabel('対応モデル系列', { exact: false }).fill(MODEL_FAMILY);
  await dialog().getByLabel('対応する実行種別', { exact: false }).selectOption([taskType]);
  await dialog().getByTestId('code-version-save').click();
  await dialog().waitFor({ state: 'hidden' });
  const codes = (await api('GET', `/projects/${projectId}/codes`)).items;
  const code = codes.find((item) => item.name === name);
  const versions = (await api('GET', `/projects/${projectId}/codes/${code.id}/versions`)).items;
  assert.equal(versions.length, 1, `${name} has no version`);
  return versions[0];
}

function assertSameLines(actual, expected, name) {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const line = expectedLines.findIndex((text, index) => actualLines[index] !== text);
  if (line === -1 && actualLines.length === expectedLines.length) return;
  throw new Error(
    `${name} changed in the editor at line ${line + 1}: ${JSON.stringify(actualLines[line])} instead of ${JSON.stringify(expectedLines[line])}`,
  );
}

async function openModelsTab(tab) {
  await page.goto(`${projectBase}/models`);
  await page.getByRole('tab', { name: tab }).click();
}

async function launchTask() {
  await page.goto(`${projectBase}/tasks`);
  await page.getByRole('button', { name: taskName }).first().click();
  await page.getByTestId('task-launch-run').click();
  await dialog().getByRole('button', { name: '通常実行', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
}

async function openVersionPage(versionId) {
  await page.goto(`${projectBase}/models/${modelId}/versions/${versionId}`);
  await page.getByRole('heading', { name: new RegExp(`${MODEL_NAME} / `) }).waitFor();
}

const reloadVersionPage = () => page.getByRole('button', { name: '再読み込み' }).first().click();

async function newestVersion(minimumCount) {
  const deadline = Date.now() + JOB_MS;
  while (Date.now() < deadline) {
    const versions = (await api('GET', `/projects/${projectId}/models/${modelId}/versions`)).items;
    if (versions.length >= minimumCount)
      return versions.toSorted((left, right) => Number(right.version) - Number(left.version))[0];
    // The Task registers the version once the training Run has finished on the worker.
    await page.getByText('完了').first().waitFor({ timeout: SCREEN_POLL_MS }).catch(() => {});
  }
  throw new Error(`The Task did not register version ${minimumCount}`);
}

async function waitForAutomation(versionId) {
  await openVersionPage(versionId);
  const automation = page.getByRole('region', { name: '自動実行' });
  // Inference and the chained evaluation both end Finished on the CPU worker.
  await waitOnScreen(automation.getByRole('row').filter({ hasText: '評価' }).filter({ hasText: '完了' }), {
    reload: reloadVersionPage,
  });
  await waitOnScreen(automation.getByRole('row').filter({ hasText: '推論' }).filter({ hasText: '完了' }), {
    reload: reloadVersionPage,
  });
  const results = page.getByRole('region', { name: '評価結果' });
  await waitOnScreen(results.getByText('evaluation.duration_match_rate'), { reload: reloadVersionPage });
}

async function promoteWithReason(reason) {
  const check = page.getByRole('region', { name: '昇格の判定' });
  await waitOnScreen(check.getByText('合格'), { reload: reloadVersionPage });
  await check.getByRole('button', { name: '昇格', exact: true }).click();
  await dialog().getByLabel('理由', { exact: false }).fill(reason);
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
}

let projectId;
let projectBase;
let modelId;
let taskName;
const ids = {};
let failed = false;
try {
  await waitForServer();

  await stage('login_and_password_change', 'ローカルユーザーでログインし、初回のパスワード変更を済ませる', async () => {
    await login(users.admin.username, passwords.admin);
    await page.getByLabel('現在のパスワード').fill(passwords.admin);
    await page.getByLabel('新しいパスワード', { exact: true }).fill(passwords.adminChanged);
    await page.getByLabel('新しいパスワード（確認）').fill(passwords.adminChanged);
    await page.getByRole('button', { name: 'パスワードを変更' }).click();
    await page.getByRole('navigation').waitFor();
    const me = await api('GET', '/auth/me');
    assert.equal(me.user.username, users.admin.username);
    assert.equal(me.mustChangePassword, false);
    return { authMode: (await api('GET', '/auth/config')).mode };
  });

  await stage('storage_connection_test', '全体管理画面で保存先（filesystem）の接続テストが全段階成功する', async () => {
    await page.goto(`${BASE}/admin`);
    await page.getByRole('tab', { name: 'ストレージ' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Filesystem' }).first();
    await row.getByRole('button', { name: '接続テスト' }).click();
    await waitOnScreen(page.getByText('すべての段階が成功しました'), { timeout: 30_000 });
    await screenshot('01-storage-connection-test');
    return { backend: (await row.innerText()).split('\n')[0] };
  });

  await stage('project_creation', '設定画面からProjectを作成する', async () => {
    await openProjectCreation(page, { base: BASE, projects: [] });
    await dialog().getByLabel('名前', { exact: false }).fill('Browser pipeline');
    await dialog().getByRole('button', { name: '作成', exact: true }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]+\/experiments/);
    projectId = new URL(page.url()).pathname.split('/')[2];
    projectBase = `${BASE}/projects/${projectId}`;
    return { projectId };
  });

  await stage('api_setup', 'local executorのtarget・Experiment・正解セット・出力Dataset・Modelを用意する（画面の無い部分）', async () => {
    const target = await api('POST', '/targets', {
      name: 'Browser pipeline CPU',
      host: '127.0.0.1',
      port: 22,
      username: 'local',
      sshKeyPath: '',
      knownHostsPath: '',
      workDirectory: path.join(workDirectory, 'jobs'),
      pythonExecutable: PYTHON,
      gpuIds: [],
      maxConcurrentJobs: 1,
      enabled: true,
      executor: 'local',
    });
    ids.targetId = target.id;
    ids.experimentId = (await api('POST', `/projects/${projectId}/experiments`, { name: 'Browser pipeline', description: '' })).id;
    const reference = await api('POST', `/projects/${projectId}/datasets`, { name: 'Browser reference lengths', namespace: 'verification' });
    ids.referenceVersionId = (
      await api('POST', `/projects/${projectId}/datasets/${reference.id}/versions`, {
        version: 'v1',
        uri: 'urn:mmt:verification:browser-pipeline-reference',
        digest: `sha256:${'0'.repeat(64)}`,
        schema: { audio: 'string', durationSeconds: 'number' },
        metadata: { samples: referenceSamples },
      })
    ).id;
    ids.outputDatasetId = (await api('POST', `/projects/${projectId}/datasets`, { name: 'Browser inference outputs', namespace: 'verification' })).id;
    modelId = (await api('POST', `/projects/${projectId}/models`, { name: MODEL_NAME, family: MODEL_FAMILY, description: '' })).id;
    return { ...ids, modelId };
  });

  await stage('service_account_worker', 'Service Accountとworker tokenを画面で発行し、CPU workerを起動する', async () => {
    await page.goto(`${projectBase}/settings`);
    await page.getByRole('button', { name: 'Service Accountを作成' }).click();
    await dialog().getByLabel('名前', { exact: false }).fill('browser-worker');
    await dialog().getByLabel('Role', { exact: false }).selectOption('admin');
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('row').filter({ hasText: 'browser-worker' }).getByRole('button', { name: 'API tokenを発行' }).click();
    await dialog().getByLabel('名前', { exact: false }).fill('browser worker');
    await dialog().getByLabel('Scope', { exact: false }).selectOption(['read', 'worker:execute', 'artifacts:write', 'registry:write']);
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    const tokenField = dialog().getByLabel('API tokens');
    await tokenField.waitFor();
    const token = await tokenField.inputValue();
    assert.match(token, /^mmt/);
    await dialog().getByRole('button', { name: '閉じる' }).last().click();
    worker = startProcess(WORKER, ['run'], {
      env: {
        MMT_API_URL: BASE,
        MMT_API_TOKEN: token,
        MMT_WORKER_ID: `browser-pipeline-${projectId.slice(0, 8)}`,
        MMT_WORKER_TARGET_IDS: ids.targetId,
        MMT_WORKER_STATE_DIR: path.join(workDirectory, 'state'),
        MMT_ALLOW_LOCAL_EXECUTOR: 'true',
      },
      logName: 'browser-pipeline-worker.log',
    });
    return { workerId: `browser-pipeline-${projectId.slice(0, 8)}` };
  });

  await stage('code_versions', 'コード版（学習・推論・評価）をinlineのファイルで登録する', async () => {
    const read = (name) => readFile(path.join(EXAMPLES, name), 'utf8');
    ids.trainingCodeVersionId = (
      await addCodeVersion({ name: 'Browser training', version: 'v1', files: { 'training.py': await read('training.py') }, entrypoint: ['python', 'training.py'], taskType: 'training' })
    ).id;
    ids.inferenceCodeVersionId = (
      await addCodeVersion({ name: 'Browser inference', version: 'v1', files: { 'inference.py': await read('inference.py') }, entrypoint: ['python', 'inference.py'], taskType: 'inference' })
    ).id;
    ids.evaluationCodeVersionId = (
      await addCodeVersion({ name: 'Browser evaluation', version: 'v1', files: { 'evaluation.py': await read('evaluation.py') }, entrypoint: ['python', 'evaluation.py'], taskType: 'evaluation' })
    ).id;
    // Monaco must not have re-indented the Python sources.
    const trainingCode = (await api('GET', `/projects/${projectId}/codes`)).items.find((code) => code.name === 'Browser training');
    const stored = (await api('GET', `/projects/${projectId}/codes/${trainingCode.id}/versions`)).items[0];
    assertSameLines(stored.source.files['training.py'], await read('training.py'), 'training.py');
    return { ...ids };
  });

  await stage('automation_rules_and_policy', '推論rule（モデル登録）・評価rule（上流ruleの成功）・昇格policyを画面で作る', async () => {
    await openModelsTab('自動実行ルール');
    await page.getByRole('button', { name: '自動実行ルールを作成' }).click();
    await dialog().getByLabel('名前', { exact: false }).fill('Browser inference');
    await dialog().getByLabel('トリガー', { exact: false }).selectOption('model_registered');
    await dialog().getByLabel('対象モデル系列', { exact: false }).selectOption([MODEL_FAMILY]);
    await dialog().getByLabel('実行種別', { exact: false }).selectOption('inference');
    await dialog().getByLabel('Experiments', { exact: false }).selectOption(ids.experimentId);
    await dialog().getByLabel('コード版', { exact: false }).selectOption(ids.inferenceCodeVersionId);
    await dialog().getByLabel('Compute target', { exact: false }).selectOption(ids.targetId);
    await dialog().getByLabel('Parameters（JSON）', { exact: false }).fill(JSON.stringify({ outputDatasetId: ids.outputDatasetId }));
    await dialog().getByRole('button', { name: '作成', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '自動実行ルールを作成' }).click();
    await dialog().getByLabel('名前', { exact: false }).fill('Browser evaluation');
    await dialog().getByLabel('トリガー', { exact: false }).selectOption('upstream_run_finished');
    await dialog().getByLabel('上流rule', { exact: false }).selectOption({ label: 'Browser inference · Inference' });
    await dialog().getByLabel('対象モデル系列', { exact: false }).selectOption([MODEL_FAMILY]);
    await dialog().getByLabel('実行種別', { exact: false }).selectOption('evaluation');
    await dialog().getByLabel('Experiments', { exact: false }).selectOption(ids.experimentId);
    await dialog().getByLabel('コード版', { exact: false }).selectOption(ids.evaluationCodeVersionId);
    await dialog().getByLabel('Compute target', { exact: false }).selectOption(ids.targetId);
    await dialog().getByLabel('入力データセット版', { exact: false }).selectOption([ids.referenceVersionId]);
    await dialog().getByRole('button', { name: '作成', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    const rules = (await api('GET', `/projects/${projectId}/automation-rules`)).items;
    ids.evaluationRuleId = rules.find((rule) => rule.name === 'Browser evaluation').id;
    assert.equal(rules.find((rule) => rule.name === 'Browser evaluation').upstreamRuleId, rules.find((rule) => rule.name === 'Browser inference').id);

    await openModelsTab('昇格policy');
    await page.getByRole('button', { name: '昇格policyを作成' }).click();
    await dialog().getByLabel('名前', { exact: false }).fill('Browser promotion gate');
    await dialog().getByLabel('対象モデル', { exact: false }).selectOption(modelId);
    await dialog().getByLabel(/^対象alias\s*\*?$/).fill(PROMOTION_ALIAS);
    await dialog().getByLabel(/^基準alias\s*\*?$/).fill(PROMOTION_ALIAS);
    await dialog().getByLabel('評価ルール', { exact: false }).selectOption(ids.evaluationRuleId);
    await dialog().getByLabel('メトリクス', { exact: false }).fill('evaluation.duration_match_rate');
    await dialog().getByLabel('良い方向', { exact: false }).selectOption({ label: '大きいほど良い' });
    await dialog().getByLabel('比べる値', { exact: false }).selectOption({ label: '候補の値' });
    await dialog().getByLabel('閾値', { exact: false }).fill('0.99');
    await dialog().getByRole('button', { name: '作成', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    const policies = (await api('GET', `/projects/${projectId}/promotion-policies`)).items;
    assert.equal(policies.length, 1);
    assert.equal(policies[0].autoPromote, false);
    await screenshot('02-promotion-policy');
    return { rules: rules.map((rule) => rule.name), policyId: policies[0].id };
  });

  await stage('training_task_with_output_model', '出力モデル付きの学習Taskを画面で作る', async () => {
    taskName = 'Browser training task';
    await page.goto(`${projectBase}/tasks`);
    await page.getByRole('button', { name: 'Taskを作成' }).click();
    await dialog().getByLabel('名前', { exact: false }).fill(taskName);
    await dialog().getByLabel('Experiments', { exact: false }).selectOption(ids.experimentId);
    await dialog().getByLabel('実行種別', { exact: false }).selectOption('training');
    await dialog().getByLabel('コード版', { exact: false }).selectOption(ids.trainingCodeVersionId);
    await dialog().getByLabel('Compute target', { exact: false }).selectOption(ids.targetId);
    const output = dialog().getByTestId('task-output-model');
    await output.getByLabel('成功時にモデル版を登録').check();
    await output.getByLabel('Models', { exact: false }).selectOption(modelId);
    await output.getByLabel('Artifactのパス', { exact: false }).fill('model/weights.json');
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    const tasks = (await api('GET', `/projects/${projectId}/tasks`)).items;
    const task = tasks.find((item) => item.name === taskName);
    assert.equal(task.outputModel.modelId, modelId);
    return { taskId: task.id, outputModel: task.outputModel };
  });

  await stage('first_run_to_evaluation', '学習を実行→CPU workerで完了→版の自動登録→推論・評価がFinishedでmetricsが出る', async () => {
    await launchTask();
    await waitOnScreen(page.getByRole('row').filter({ hasText: '完了' }));
    const version = await newestVersion(1);
    ids.firstVersionId = version.id;
    await waitForAutomation(version.id);
    await screenshot('03-version-1-evaluated');
    return { version: version.version, versionId: version.id };
  });

  await stage('first_promotion_with_reason', '判定（基準なしの初回合格）を根拠に理由を入れて昇格する', async () => {
    await promoteWithReason('初回の評価で全サンプルの長さが一致したため');
    await waitOnScreen(page.getByText(PROMOTION_ALIAS).first(), { reload: reloadVersionPage });
    const detail = await api('GET', `/projects/${projectId}/model-versions/${ids.firstVersionId}`);
    assert.deepEqual(detail.aliases, [PROMOTION_ALIAS]);
    return { aliases: detail.aliases };
  });

  await stage('second_run_baseline_comparison', '2回目の学習の版を基準版（production）と比べ、理由を入れて昇格する', async () => {
    await launchTask();
    const version = await newestVersion(2);
    ids.secondVersionId = version.id;
    await waitForAutomation(version.id);
    const comparison = page.getByRole('region', { name: '基準版との評価比較' });
    await waitOnScreen(comparison.getByRole('row').filter({ hasText: 'evaluation.duration_match_rate' }), { reload: reloadVersionPage });
    await screenshot('04-version-2-baseline-comparison');
    const comparisonText = await comparison.innerText();
    await promoteWithReason('基準版と同じ一致率を保ったため');
    const detail = await api('GET', `/projects/${projectId}/model-versions/${version.id}`);
    assert.deepEqual(detail.aliases, [PROMOTION_ALIAS]);
    return { version: version.version, comparisonExcerpt: comparisonText.slice(0, 400) };
  });

  await stage('alias_history', 'Modelsの画面でaliasの履歴に2回の昇格と理由が残る', async () => {
    await page.goto(`${projectBase}/models`);
    await page.getByRole('button', { name: MODEL_NAME }).first().click();
    // The history is the table under the heading 「Aliasの履歴」 (columns 旧版 → 新版, 理由).
    const history = page.getByRole('table').filter({ hasText: '理由' }).filter({ hasText: '経路' });
    await waitOnScreen(history.getByText('基準版と同じ一致率を保ったため'), { timeout: 30_000 });
    await waitOnScreen(history.getByText('初回の評価で全サンプルの長さが一致したため'), { timeout: 5_000 });
    await screenshot('05-alias-history');
    const events = (await api('GET', `/projects/${projectId}/models/${modelId}/alias-events`)).items;
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.source === 'web'));
    return { events: events.map((event) => ({ version: event.version, previousVersion: event.previousVersion, reason: event.reason })) };
  });

  await stage('viewer_through_group_binding', 'group bindingでviewerにしたユーザーは見られるが操作できない', async () => {
    await page.goto(`${projectBase}/settings`);
    await page.getByRole('button', { name: 'groupを追加' }).click();
    await dialog().getByLabel('group名', { exact: false }).fill(users.viewerGroup);
    await dialog().getByLabel('Role', { exact: false }).selectOption('viewer');
    await dialog().getByRole('button', { name: '保存', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    await logout();
    await login(users.viewer.username, passwords.viewer);
    await page.getByRole('navigation').waitFor();
    const projects = (await api('GET', '/projects')).items;
    assert.equal(projects.find((project) => project.id === projectId)?.role, 'viewer');
    await openVersionPage(ids.secondVersionId);
    await page.getByRole('region', { name: '評価結果' }).getByText('evaluation.duration_match_rate').first().waitFor();
    assert.equal(await page.getByRole('region', { name: '昇格の判定' }).count(), 0, 'a viewer sees the promotion card');
    // The reload button is the only control left; it has an icon and an accessible name.
    const versionPage = page.locator('.model-version-page');
    const buttons = await versionPage.getByRole('button').count();
    assert.equal(buttons, 1, 'a viewer has controls besides reload on the version page');
    await versionPage.getByRole('button', { name: '再読み込み' }).waitFor();
    await screenshot('06-viewer-version-page');
    await openModelsTab('自動実行ルール');
    assert.equal(await page.getByRole('button', { name: '自動実行ルールを作成' }).count(), 0);
    await openModelsTab('昇格policy');
    assert.equal(await page.getByRole('button', { name: '昇格policyを作成' }).count(), 0);
    // The API refuses what the screen hides.
    const refused = await page.request.put(`${BASE}/api/projects/${projectId}/models/${modelId}/aliases/${PROMOTION_ALIAS}`, {
      headers: { Origin: BASE, 'Content-Type': 'application/json' },
      data: JSON.stringify({ versionId: ids.firstVersionId, reason: 'viewer attempt' }),
    });
    assert.equal(refused.status(), 403);
    return { versionPageButtonCount: buttons, aliasChangeStatus: refused.status() };
  });
  assert.deepEqual(pageErrors, []);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
  await stopProcess(worker);
  await stopProcess(server);
  const report = {
    finishedAt: new Date().toISOString(),
    base: BASE,
    authMode: 'local',
    outOfScope: ['実SSO（Authentik）', 'GPU', '実S3', '本番Mado', '実SSH'],
    result: failed ? 'failed' : 'passed',
    pageErrors,
    stages,
  };
  const reportPath = path.join(reportDirectory, 'browser-pipeline.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.result}: ${path.relative(ROOT, reportPath)}`);
  process.exitCode = failed ? 1 : 0;
}
