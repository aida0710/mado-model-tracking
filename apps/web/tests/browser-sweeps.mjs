// Browser check of the Sweeps screens against an isolated API (port 47130), Vite (47131) and a
// real CPU worker with the local executor. A grid 2×2 sweep with parallelism 2 runs the SDK's
// sweep_training.py example; the check covers a search space error shown on its row, pause and
// resume, trials finishing in order with a best trial, and a viewer who sees no operations.
// It creates a temporary schema in mmt_test, so the shared development API and DB are untouched.
//
//   (cd apps/web && MMT_WEB_API_PROXY_TARGET=http://127.0.0.1:47130 npx vite --port 47131 --strictPort --host 127.0.0.1) &
//   MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55490/mmt_test \
//   MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
//   MMT_SCREENSHOT_DIR=artifacts/verification/<日付>/sweeps-web \
//   npx tsx apps/web/tests/browser-sweeps.mjs
//
// tsx is needed because the script starts the API from its TypeScript sources. The worker and the
// target's job setup use a temporary venv made with `uv venv --seed`: each trial installs httpx
// into its job venv with that pip, and neither the system python3 nor the uv-managed python of
// python/.venv has pip or ensurepip.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { serve } from '@hono/node-server';
import { createArtifactStoresFromEnv } from '@mmt/platform';
import { createApplication } from '../../api/src/app.ts';
import { loadConfig } from '../../api/src/config.ts';
import { migrate } from '../../api/src/db/migrate.ts';
import { serverTimeouts } from '../../api/src/http/serverTimeouts.ts';

const API_PORT = 47130;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:47131';
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// A trial creates a venv and installs httpx before training; several trials run per sweep.
const SWEEP_TIMEOUT_MS = 240_000;
const UI_TIMEOUT_MS = 30_000;
const STATE_POLL_MS = 500;
const PARALLELISM = 2;
const GRID_TRIALS = 4;

const databaseUrl = process.env.MMT_TEST_DATABASE_URL;
if (!databaseUrl || !/^\/mmt_test(?:_|$)/.test(new URL(databaseUrl).pathname))
  throw new Error('MMT_TEST_DATABASE_URL must point to the dedicated mmt_test database');
const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;

const schema = `mmt_sweeps_browser_${randomBytes(4).toString('hex')}`;
const administrator = new pg.Pool({ connectionString: databaseUrl });
await administrator.query(`CREATE SCHEMA ${schema}`);
const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-sweeps-browser-artifacts-'));
const workerDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-sweeps-browser-worker-'));
const config = loadConfig({
  MMT_DATABASE_URL: databaseUrl,
  AUTH_MODE: 'development',
  PORT: String(API_PORT),
  MMT_WEB_ORIGIN: WEB_URL,
  // The local executor runs trials on this machine; the API accepts it only in development mode.
  MMT_ALLOW_LOCAL_EXECUTOR: 'true',
});
const application = createApplication({
  config,
  database,
  stores: createArtifactStoresFromEnv({ ARTIFACT_FILESYSTEM_ROOT: artifactDirectory }),
});
let server;
let worker;
const workerLog = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true });
}

async function devLogin(context, email, displayName) {
  const page = await context.newPage();
  await page.goto(WEB_URL);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('表示名').fill(displayName);
  const loggedIn = page.waitForResponse((response) => response.url().endsWith('/api/auth/dev-login'));
  await page.getByRole('button', { name: '開発モードでログイン', exact: true }).click();
  const { user } = await (await loggedIn).json();
  return { page, user };
}

function apiClient(page) {
  const call = async (method, endpoint, body) => {
    const response = await page.request.fetch(`${WEB_URL}/api${endpoint}`, {
      method,
      ...(body === undefined ? {} : { data: body }),
      headers: { Origin: WEB_URL },
    });
    assert.ok(response.ok(), `${method} ${endpoint}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? undefined : response.json();
  };
  return { get: (endpoint) => call('GET', endpoint), post: (endpoint, body) => call('POST', endpoint, body), put: (endpoint, body) => call('PUT', endpoint, body) };
}

async function waitFor(description, read, isDone, timeout = SWEEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (isDone(value)) return value;
    if (worker?.exitCode !== null && worker?.exitCode !== undefined)
      throw new Error(`Worker exited (${worker.exitCode}) while waiting for ${description}:\n${workerLog.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}\n${workerLog.slice(-40).join('')}`);
}

/** The first failed trial's Run error and last log lines, so a failing check says why. */
async function describeFailedTrial(api, { projectPath, sweepPath }) {
  const failed = (await api.get(`${sweepPath}/trials`)).items.find((trial) => trial.state === 'failed');
  if (!failed) return 'no failed trial';
  const run = await api.get(`${projectPath}/runs/${failed.runId}`);
  const logs = await api.get(`${projectPath}/runs/${failed.runId}/logs`);
  return `trial ${failed.trialIndex} failed: ${run.error}\n${logs.items.slice(-20).map((entry) => entry.message).join('')}`;
}

/** A venv with pip and this worktree's SDK, for the worker and the target's job setup. */
async function installWorkerEnvironment() {
  const environment = path.join(workerDirectory, 'venv');
  const run = promisify(execFile);
  await run('uv', ['venv', '--seed', '--quiet', environment]);
  await run('uv', ['pip', 'install', '--quiet', '--python', path.join(environment, 'bin/python'), path.join(REPOSITORY, 'python')]);
  return { worker: path.join(environment, 'bin/mado-tracking-worker'), python: path.join(environment, 'bin/python') };
}

function startWorker({ executable, token, targetId }) {
  // The token travels only in the child's environment, never in argv or logs.
  const child = spawn(executable, ['run'], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MMT_API_URL: API_URL,
      MMT_API_TOKEN: token,
      MMT_WORKER_ID: `sweeps-browser-${schema}`,
      MMT_WORKER_TARGET_IDS: targetId,
      MMT_WORKER_STATE_DIR: path.join(workerDirectory, 'state'),
      MMT_ALLOW_LOCAL_EXECUTOR: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => workerLog.push(String(chunk)));
  child.stderr.on('data', (chunk) => workerLog.push(String(chunk)));
  return child;
}

try {
  await migrate(database);
  server = serve({
    fetch: application.app.fetch,
    hostname: '127.0.0.1',
    port: API_PORT,
    serverOptions: serverTimeouts(config).serverOptions,
  });

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const { page, user: adminUser } = await devLogin(adminContext, 'admin@localhost', '検証管理者');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const api = apiClient(page);

  // Fixtures: a Task that runs the SDK's sweep example on a local CPU target.
  const project = await api.post('/projects', { name: 'Sweeps browser check' });
  const projectPath = `/projects/${project.id}`;
  const experiment = await api.post(`${projectPath}/experiments`, { name: 'lr search' });
  const code = await api.post(`${projectPath}/codes`, { name: 'Sweep training' });
  const codeVersion = await api.post(`${projectPath}/codes/${code.id}/versions`, {
    version: 'v1',
    source: { kind: 'inline', files: { 'sweep_training.py': await readFile(path.join(REPOSITORY, 'python/examples/sweep_training.py'), 'utf8') } },
    entrypoint: ['python', 'sweep_training.py'],
    supportedModelFamilies: ['linear'],
    taskTypes: ['training'],
  });
  const workerEnvironment = await installWorkerEnvironment();
  const target = await api.post('/targets', {
    name: 'Sweep CPU target',
    host: '127.0.0.1',
    port: 22,
    username: 'local',
    sshKeyPath: '',
    knownHostsPath: '',
    workDirectory: path.join(workerDirectory, 'jobs'),
    pythonExecutable: workerEnvironment.python,
    gpuIds: [],
    maxConcurrentJobs: PARALLELISM,
    enabled: true,
    executor: 'local',
  });
  const task = await api.post(`${projectPath}/tasks`, {
    experimentId: experiment.id,
    name: 'Linear regression',
    kind: 'training',
    codeVersionId: codeVersion.id,
    parameters: { lr: 0.05, batch_size: 4, epochs: 3 },
    tags: {},
    targetId: target.id,
    gpuIds: [],
  });
  const issued = await api.post('/tokens', {
    name: 'Sweeps browser worker',
    kind: 'service',
    projectId: project.id,
    scopes: ['read', 'runs:write', 'artifacts:write', 'jobs:write', 'worker:execute'],
  });
  worker = startWorker({ executable: workerEnvironment.worker, token: issued.token, targetId: target.id });

  // Create: a server-side 422 lands on its row, a W&B key the screen does not support is refused.
  await page.goto(`${WEB_URL}${projectPath}/sweeps`);
  await page.getByRole('link', { name: 'Sweeps', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sweepを作成' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(`Task revision ${task.revision}`).waitFor();
  await dialog.getByLabel('名前', { exact: true }).fill('lr-grid');
  await dialog.getByLabel('目的メトリクス').fill('val_loss');

  await dialog.getByRole('button', { name: 'W&B形式のJSON' }).click();
  await dialog.getByLabel('W&B形式のJSON', { exact: true }).fill(JSON.stringify({
    method: 'grid', metric: { name: 'val_loss', goal: 'minimize' }, parameters: { lr: { values: [0.1] } }, run_cap: 1, program: 'train.py',
  }));
  await dialog.getByRole('button', { name: '読み込む' }).click();
  await dialog.getByText('sweep configの未対応のキー: program').waitFor();

  await dialog.getByRole('button', { name: '行で編集' }).click();
  const rows = dialog.getByTestId('sweep-space-row');
  await rows.nth(0).getByLabel('parameter名', { exact: true }).fill('lr');
  await rows.nth(0).getByLabel('種類').selectOption('range');
  await rows.nth(0).getByLabel('min', { exact: true }).fill('0.1');
  await rows.nth(0).getByLabel('max', { exact: true }).fill('0.01');
  await dialog.getByRole('button', { name: '作成' }).click();
  const rowError = rows.nth(0).getByRole('alert');
  await rowError.waitFor({ timeout: UI_TIMEOUT_MS });
  assert.match(await rowError.innerText(), /「lr」.*min < max/);
  await screenshot(page, 'sweep-create-row-error');

  await dialog.getByLabel('探索方法').selectOption('grid');
  await rows.nth(0).getByLabel('種類').selectOption('values');
  await rows.nth(0).getByLabel('値（カンマ区切り）').fill('0.1, 0.05');
  await dialog.getByRole('button', { name: 'parameterを追加' }).click();
  await rows.nth(1).getByLabel('parameter名', { exact: true }).fill('batch_size');
  await rows.nth(1).getByLabel('値（カンマ区切り）').fill('4, 8');
  await dialog.getByTestId('sweep-grid-count').getByText('gridの組み合わせ: 4通り').waitFor();
  await dialog.getByLabel('最大試行数').fill(String(GRID_TRIALS));
  await dialog.getByLabel('並列数').fill(String(PARALLELISM));
  await screenshot(page, 'sweep-create-grid');
  await dialog.getByRole('button', { name: '作成' }).click();
  await page.getByTestId('sweep-detail-page').waitFor({ timeout: UI_TIMEOUT_MS });
  const sweepId = page.url().split('/').pop();
  const sweepPath = `${projectPath}/sweeps/${sweepId}`;
  const readSweep = () => api.get(sweepPath);

  const created = await readSweep();
  assert.equal(created.trialCounts.total, PARALLELISM, 'Creation queues as many trials as the parallelism');
  assert.deepEqual(created.searchSpace, { lr: { values: [0.1, 0.05] }, batch_size: { values: [4, 8] } });

  // Pause: the two trials in flight finish, no third trial is queued until resume.
  await page.getByRole('button', { name: '一時停止' }).click();
  await page.getByTestId('sweep-status-reason').getByText('利用者の操作').waitFor({ timeout: UI_TIMEOUT_MS });
  const paused = await waitFor('the paused trials to end', readSweep,
    (sweep) => sweep.trialCounts.queued + sweep.trialCounts.running === 0);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.trialCounts.total, PARALLELISM, 'A paused sweep queues no new trial');
  // Polling continues while paused trials are in flight, so the page catches up with the API.
  await page.locator('.sweep-state-counts').getByText(`完了 ${PARALLELISM}`).waitFor({ timeout: UI_TIMEOUT_MS });
  await page.getByTestId('sweep-trial-progress').getByText(`${PARALLELISM} / ${GRID_TRIALS}`).waitFor();
  await screenshot(page, 'sweep-paused');

  await page.getByRole('button', { name: '再開' }).click();
  const finished = await waitFor('the sweep to finish', readSweep, (sweep) => sweep.status === 'finished');
  // maxTrials equals the grid size, so either limit may be the one recorded.
  assert.ok(['max_trials_reached', 'search_space_exhausted'].includes(finished.statusReason), finished.statusReason);
  assert.equal(finished.trialCounts.finished, GRID_TRIALS, await describeFailedTrial(api, { projectPath, sweepPath }));
  assert.ok(finished.bestTrial, 'A finished sweep has a best trial');

  const trials = (await api.get(`${sweepPath}/trials`)).items;
  assert.deepEqual(trials.map((trial) => trial.trialIndex), [0, 1, 2, 3]);
  const bestObjective = Math.min(...trials.map((trial) => trial.objectiveValue));
  assert.equal(finished.bestTrial.objectiveValue, bestObjective);

  await page.locator('.sweep-summary .status-badge').getByText('完了').waitFor({ timeout: UI_TIMEOUT_MS });
  await page.getByTestId('sweep-trial-progress').getByText(`${GRID_TRIALS} / ${GRID_TRIALS}`).waitFor();
  const bestSection = page.getByTestId('sweep-best-trial');
  await bestSection.getByRole('link', { name: `#${finished.bestTrial.trialIndex}` }).waitFor();
  assert.equal(await page.getByTestId('sweep-trials').locator('tbody tr').count(), GRID_TRIALS);
  await page.getByTestId('sweep-trials').getByLabel('並び順').selectOption('objective');
  assert.equal(
    (await page.getByTestId('sweep-trials').locator('tbody tr').first().locator('td').first().innerText()).trim(),
    `#${finished.bestTrial.trialIndex}`,
  );
  await page.locator('.sweep-progress-chart').waitFor();
  // Ended sweeps offer no operations even to their creator.
  assert.equal(await page.getByRole('button', { name: '一時停止' }).count(), 0);
  await screenshot(page, 'sweep-finished');

  await page.goto(`${WEB_URL}${projectPath}/sweeps`);
  await page.getByRole('link', { name: 'lr-grid' }).waitFor();
  await screenshot(page, 'sweeps-list');

  // A viewer sees the list and the detail but no create or control buttons. A second sweep is
  // kept running so the controls would show if the viewer were allowed to use them.
  const runningSweep = await api.post(`${projectPath}/sweeps`, {
    name: 'viewer check',
    taskId: task.id,
    method: 'random',
    searchSpace: { lr: { distribution: 'uniform', min: 0.01, max: 0.1 } },
    objective: { metric: 'val_loss', goal: 'minimize' },
    maxTrials: 1,
  });
  await api.post(`${projectPath}/sweeps/${runningSweep.id}/pause`);
  const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const { page: viewerPage, user: viewer } = await devLogin(viewerContext, 'viewer@localhost', '閲覧者');
  await api.put(`${projectPath}/members/${viewer.id}`, { role: 'viewer' });
  await viewerPage.goto(`${WEB_URL}${projectPath}/sweeps`);
  await viewerPage.getByRole('link', { name: 'viewer check' }).waitFor();
  assert.equal(await viewerPage.getByRole('button', { name: 'Sweepを作成' }).count(), 0);
  await viewerPage.getByRole('link', { name: 'viewer check' }).click();
  await viewerPage.getByTestId('sweep-summary').waitFor();
  for (const name of ['一時停止', '再開', 'Sweepを中止', '試行数・並列数を変更'])
    assert.equal(await viewerPage.getByRole('button', { name }).count(), 0, `viewer must not see ${name}`);
  await screenshot(viewerPage, 'sweep-viewer');
  // The creator still sees resume on the same paused sweep.
  await page.goto(`${WEB_URL}${projectPath}/sweeps/${runningSweep.id}`);
  await page.getByRole('button', { name: '再開' }).waitFor();
  await api.post(`${projectPath}/sweeps/${runningSweep.id}/cancel`, { cancelRunningTrials: true });

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    sweepId,
    adminUserId: adminUser.id,
    trials: trials.map((trial) => ({ trialIndex: trial.trialIndex, parameters: trial.parameters, objective: trial.objectiveValue, state: trial.state })),
    bestTrialIndex: finished.bestTrial.trialIndex,
  }, null, 2));
} finally {
  if (worker && worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill('SIGTERM');
    await exited;
  }
  await browser.close();
  await application.outbox.stop();
  await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await database.end();
  await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
  await administrator.end();
  await rm(artifactDirectory, { recursive: true, force: true });
  await rm(workerDirectory, { recursive: true, force: true });
}
