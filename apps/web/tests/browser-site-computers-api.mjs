// Browser check of computers added on the Web (launchers, sites, job shells, personal settings,
// sharing, manual submission) against an isolated API in development mode (port 47140) and Vite
// (47141). It creates a temporary schema in mmt_test, so the shared development API and DB are
// untouched; the records are made through the screens, and through the API only where no screen
// exists (Projects and their members, code versions, and what the launcher and
// `mado-tracking submit` send).
//
//   (cd apps/web && MMT_WEB_API_PROXY_TARGET=http://127.0.0.1:47140 npx vite --port 47141 --strictPort --host 127.0.0.1) &
//   MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55483/mmt_test \
//   MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
//   MMT_CHROMIUM_PATH=/path/to/chromium \
//   MMT_SCREENSHOT_DIR=artifacts/verification/<日付>/site-computers-api-web \
//   npx tsx apps/web/tests/browser-site-computers-api.mjs
//
// tsx is needed because the script starts the API from its TypeScript sources. Keep the Web's
// files unchanged during the run: the dev server would hot-reload the open pages. Where they may
// change, serve a build instead (`npx vite build --outDir <dir>`, then
// `npx vite preview --outDir <dir> --port 47141 --strictPort --host 127.0.0.1` with the same
// MMT_WEB_API_PROXY_TARGET).
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { serve } from '@hono/node-server';
import { createArtifactStoresFromEnv } from '@mmt/platform';
import { createApplication } from '../../api/src/app.ts';
import { loadConfig } from '../../api/src/config.ts';
import { migrate } from '../../api/src/db/migrate.ts';
import { serverTimeouts } from '../../api/src/http/serverTimeouts.ts';

const API_PORT = 47140;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:47141';
const DESKTOP = { width: 1440, height: 1000 };
const PHONE_WIDTH = 390;
// Keys and checks waiting for the launcher are read again every few seconds (EXECUTION_POLL_MS).
const LAUNCHER_ANSWER_TIMEOUT_MS = 20_000;
// The global administrator of development mode (DEVELOPMENT_ADMIN_EMAIL's default).
const ADMIN_EMAIL = 'admin@localhost';
// Any image pinned to a digest: no Job runs here, so it is never pulled.
const DOCKER_IMAGE = `registry.example.invalid/mmt/site-job@sha256:${'a'.repeat(64)}`;
const WORK_DIRECTORY_LABEL = '作業ディレクトリ（計算ノードからも同じパスで見える絶対パス）';
// What the owner of a PC is told about --all, and what other members are told besides the command
// (someone else's computer may be their PC or, say, a supercomputer each requester logs in to).
const ALL_SCOPE_NOTE = '--allで受け取るのは、使ったtokenのProjectのJobです。';
const OWNER_SUBMITS_NOTE = (owner) =>
  `この計算機は${owner}さんの計算機です。所有者が--watch --allで待ち受けている計算機（所有者のPCなど）では、所有者の側で投入されます。`;
const NO_LONGER_SHAREABLE = '（所有者がEditor以上ではありません）';
const PERSONAL_VARIABLES_LABEL = '変数（任意。NAME=VALUEを1行に1つ。計算機の変数より優先します）';
// The templates the dialog offers are the deploy/sites examples as they are.
const exampleJobShell = (key) =>
  readFileSync(new URL(`../../../deploy/sites/examples/${key}/job.sh`, import.meta.url), 'utf8');

const databaseUrl = process.env.MMT_TEST_DATABASE_URL;
if (!databaseUrl || !/^\/mmt_test(?:_|$)/.test(new URL(databaseUrl).pathname))
  throw new Error('MMT_TEST_DATABASE_URL must point to the dedicated mmt_test database');
const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;

const schema = `mmt_sites_browser_${randomBytes(4).toString('hex')}`;
const administrator = new pg.Pool({ connectionString: databaseUrl });
await administrator.query(`CREATE SCHEMA ${schema}`);
const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-sites-browser-artifacts-'));
const config = loadConfig({
  MMT_DATABASE_URL: databaseUrl,
  AUTH_MODE: 'development',
  PORT: String(API_PORT),
  MMT_WEB_ORIGIN: WEB_URL,
  DEVELOPMENT_ADMIN_EMAIL: ADMIN_EMAIL,
});
let application;
let server;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const pageErrors = [];
// A render error caught by the app's error boundary never reaches pageerror; React logs it here.
const consoleErrors = [];

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true });
}

/** An OpenSSH ed25519 public key line, as ssh-keygen and ssh-keyscan print one. */
function sshPublicKey(comment) {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const field = (bytes) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const blob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]);
  return `ssh-ed25519 ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`;
}

function apiClient(page) {
  const call = async (method, endpoint, body) =>
    page.request.fetch(`${WEB_URL}/api${endpoint}`, {
      method,
      headers: { Origin: WEB_URL, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { data: JSON.stringify(body) }),
    });
  const ok = async (method, endpoint, body) => {
    const response = await call(method, endpoint, body);
    assert.equal(response.ok(), true, `${method} ${endpoint}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? undefined : response.json();
  };
  return {
    raw: call,
    get: (endpoint) => ok('GET', endpoint),
    post: (endpoint, body) => ok('POST', endpoint, body),
    put: (endpoint, body) => ok('PUT', endpoint, body),
  };
}

/** What the launcher (or `mado-tracking submit`) sends with its own token, without a session. */
async function withToken(token, method, endpoint, body) {
  const response = await fetch(`${API_URL}/api${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}

async function signIn(email, displayName) {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${email}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${email}: ${message.text()}`);
  });
  await page.goto(WEB_URL);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('表示名').fill(displayName);
  const loginButton = page.getByRole('button', { name: '開発モードでログイン', exact: true });
  await loginButton.click();
  // A new user has no Project yet, so the app shell may not show navigation.
  await loginButton.waitFor({ state: 'detached' });
  const api = apiClient(page);
  const { user } = await api.get('/auth/me');
  return { page, api, user };
}

const openDialog = (page) => page.getByRole('dialog').last();
const waitForNoDialog = (page) =>
  page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 0);
const jobShellEditor = (scope) => scope.getByRole('textbox', { name: 'job shell', exact: true });
const siteDetails = (page) => page.getByTestId('site-computer-details');

async function assertNoSidewaysScroll(page, where) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${where}: the page scrolls sideways by ${overflow}px`);
}

/** The launcher dialog after a token was issued: the token once, and launcher.toml without it. */
async function readIssuedToken(page) {
  const dialog = openDialog(page);
  const field = dialog.getByLabel('launcherのtoken', { exact: true });
  await field.waitFor();
  const token = await field.inputValue();
  assert.match(token, /^mmt_/);
  const example = await dialog.getByTestId('launcher-config-example').textContent();
  assert.ok(example.includes(`api_url = "${WEB_URL}"`), example);
  assert.ok(!example.includes(token), 'launcher.toml names the token file instead of the token');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).last().click();
  await waitForNoDialog(page);
  assert.equal((await page.content()).includes(token), false, 'the token is gone with the dialog');
  return token;
}

/**
 * Fills a global administrator's dialog for an automatic global site from a template, with the
 * values each example's README lists for the Web; the caller saves it.
 */
async function addGlobalSite(page, site) {
  await page.getByRole('button', { name: '計算機を追加', exact: true }).click();
  const dialog = openDialog(page);
  await dialog.getByLabel('Executor').selectOption('site');
  assert.equal(await dialog.getByLabel('使える範囲').inputValue(), 'global');
  await dialog.getByLabel('job shellの雛形').selectOption(site.template);
  assert.equal(await jobShellEditor(dialog).inputValue(), exampleJobShell(site.template));
  await dialog.getByLabel('名前').fill(site.name);
  await dialog.getByLabel('launcher').selectOption(site.launcherId);
  await dialog.getByLabel('接続先のhost').fill(site.host);
  await dialog
    .getByLabel('known_hosts（接続先と経由するホストの行）')
    .fill(`${site.host} ${sshPublicKey()}`);
  await dialog.getByLabel('ログインするアカウント').selectOption(site.accountMode);
  if (site.sharedAccount) await dialog.getByLabel('共用アカウント名').fill(site.sharedAccount);
  await dialog.getByLabel(WORK_DIRECTORY_LABEL).fill(site.workDirectory);
  await dialog.getByLabel('runnerのPython（3.11以上）').fill(site.runnerPython);
  return dialog;
}

/** The Launch dialog's first step, then the choices of where the Job runs. */
async function openTargetChoices(page, { project, runName }) {
  await page.goto(`${WEB_URL}/projects/${project.project.id}/jobs`);
  await page.getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  const dialog = openDialog(page);
  await dialog.getByLabel('Run名').fill(runName);
  await dialog.getByLabel('Experiments').selectOption(project.experiment.id);
  await dialog.getByLabel('実行種別').selectOption('training');
  await dialog.getByLabel('コード版').selectOption(project.codeVersion.id);
  await dialog.getByRole('button', { name: '次へ', exact: true }).click();
  const targetSelect = dialog.getByLabel('Compute target');
  await targetSelect.waitFor();
  const choices = await targetSelect.locator('option').allTextContents();
  return { dialog, targetSelect, choices };
}

const isChoiceOf = (name) => (choice) => choice.startsWith(`${name} · `);

try {
  await migrate(database);
  // Made after the migrations, so its first read of the storage backends finds their table.
  application = createApplication({
    config,
    database,
    stores: createArtifactStoresFromEnv({ ARTIFACT_FILESYSTEM_ROOT: artifactDirectory }),
  });
  server = serve({
    fetch: application.app.fetch,
    hostname: '127.0.0.1',
    port: API_PORT,
    serverOptions: serverTimeouts(config).serverOptions,
  });

  console.log('Setup: the users, two Projects with a container code version, and their members');
  const admin = await signIn(ADMIN_EMAIL, '計算機の管理者');
  assert.equal(admin.user.isAdmin, true);
  const alice = await signIn('sites-alice@localhost', 'Alice');
  const bob = await signIn('sites-bob@localhost', 'Bob');
  async function createProject(name) {
    const project = await admin.api.post('/projects', { name });
    const experiment = await admin.api.post(`/projects/${project.id}/experiments`, { name: '計算機の検証' });
    const code = await admin.api.post(`/projects/${project.id}/codes`, { name: 'site-job' });
    const codeVersion = await admin.api.post(`/projects/${project.id}/codes/${code.id}/versions`, {
      version: 'docker-v1',
      runtime: { kind: 'docker', image: DOCKER_IMAGE },
      entrypoint: ['python', 'train.py'],
      supportedModelFamilies: ['asr'],
      taskTypes: ['training'],
    });
    for (const member of [alice, bob])
      await admin.api.put(`/projects/${project.id}/members/${member.user.id}`, { role: 'editor' });
    return { project, experiment, codeVersion };
  }
  // Alice shares her PC with the first Project only; both are Projects she could share it with.
  const sharedProject = await createProject('Site computers A');
  const otherProject = await createProject('Site computers B');
  // The administrator's own Project, which Alice is not in: never a choice for her computer.
  const adminOnlyProject = await admin.api.post('/projects', { name: 'Site computers admin' });
  const computeOf = (project) => `${WEB_URL}/projects/${project.project.id}/compute`;

  console.log('Launcher: a global administrator registers one; the token is shown once');
  const adminPage = admin.page;
  await adminPage.goto(`${WEB_URL}/admin`);
  await adminPage.getByRole('tab', { name: 'launcher', exact: true }).click();
  await adminPage.getByText('launcherはまだ登録されていません。').waitFor();
  await adminPage.getByRole('button', { name: 'launcherを登録', exact: true }).click();
  await openDialog(adminPage).getByLabel('名前').fill('main');
  await openDialog(adminPage).getByRole('button', { name: '作成', exact: true }).click();
  const firstToken = await readIssuedToken(adminPage);
  const launcherRow = adminPage.getByRole('row').filter({ hasText: 'main' });
  await launcherRow.getByText('有効', { exact: true }).waitFor();
  await launcherRow.getByText(`${firstToken.slice(0, 12)}…`).waitFor();
  const [launcher] = (await admin.api.get('/launchers')).items;
  assert.equal(JSON.stringify(launcher).includes(firstToken), false, 'the list never returns the token');
  assert.equal((await withToken(firstToken, 'GET', '/launcher/config')).status, 200);
  await screenshot(adminPage, 'launcher-registered');

  console.log('Launcher: a new token replaces the old one, which stops working at once');
  await launcherRow.getByRole('button', { name: 'tokenを作り直す', exact: true }).click();
  await openDialog(adminPage).getByRole('button', { name: 'tokenを作り直す', exact: true }).click();
  const launcherToken = await readIssuedToken(adminPage);
  assert.notEqual(launcherToken, firstToken);
  await launcherRow.getByText(`${launcherToken.slice(0, 12)}…`).waitFor();
  assert.equal((await withToken(firstToken, 'GET', '/launcher/config')).status, 401);
  assert.equal((await withToken(launcherToken, 'GET', '/launcher/config')).status, 200);

  console.log('Global sites: PBS with each person\'s own account, and a GPU host on a shared account');
  await adminPage.goto(computeOf(sharedProject));
  const pbsDialog = await addGlobalSite(adminPage, {
    template: 'pbs',
    name: 'ABCI',
    launcherId: launcher.id,
    host: 'login.abci.example.invalid',
    accountMode: 'personal',
    workDirectory: '/groups/gaa00000/mmt',
    runnerPython: '/groups/gaa00000/mmt/python/bin/python3',
  });
  await screenshot(adminPage, 'global-pbs-dialog');
  await pbsDialog.getByRole('button', { name: '保存', exact: true }).click();
  await waitForNoDialog(adminPage);
  const adminDetails = siteDetails(adminPage);
  await adminDetails.getByRole('heading', { name: 'ABCI' }).waitFor();
  await adminDetails.getByText('版1を表示しています').waitFor();
  await adminDetails
    .getByRole('region', { name: '利用者の設定' })
    .getByText('この計算機の設定を保存した人はまだいません。')
    .waitFor();
  const abci = (await admin.api.get('/targets')).items.find((target) => target.name === 'ABCI');
  assert.equal(abci.ownerUserId, null);
  assert.equal(abci.submissionMode, 'automatic');
  assert.equal(abci.supportsArray, true);
  assert.deepEqual(abci.runtimeKinds, ['singularity']);
  assert.equal(abci.siteAccountMode, 'personal');
  assert.equal(abci.site.launcherId, launcher.id);
  assert.equal(abci.site.cancelCommand, 'qdel "$MMT_SCHEDULER_JOB_ID"');
  assert.equal(abci.site.gpuAssignment, 'scheduler');
  assert.equal(abci.site.workDirectory, '/groups/gaa00000/mmt');
  assert.equal(abci.site.jobShell.version, 1);
  // Each person's key is asked for when they save their account; a new site has none yet.
  assert.deepEqual((await admin.api.get(`/targets/${abci.id}/keys`)).items, []);

  const gpuDialog = await addGlobalSite(adminPage, {
    template: 'direct-docker',
    name: 'GPU server',
    launcherId: launcher.id,
    host: 'gpu.example.invalid',
    accountMode: 'shared',
    sharedAccount: 'mmt-runner',
    workDirectory: '/srv/mmt',
    runnerPython: 'python3',
  });
  await gpuDialog.getByRole('button', { name: '保存', exact: true }).click();
  await waitForNoDialog(adminPage);
  await adminDetails.getByRole('heading', { name: 'GPU server' }).waitFor();
  const sharedKeys = adminDetails.getByRole('region', { name: '鍵と接続確認' });
  await sharedKeys.getByText('launcherが鍵を作るのを待っています', { exact: false }).waitFor();
  await sharedKeys.getByText('作成待ち', { exact: true }).waitFor();
  // The API refuses a login check until the launcher has made the key (site_check_unavailable).
  assert.equal(await sharedKeys.getByRole('button', { name: '接続を確認', exact: true }).isDisabled(), true);
  const gpuServer = (await admin.api.get('/targets')).items.find((target) => target.name === 'GPU server');
  assert.equal(gpuServer.siteAccountMode, 'shared');
  assert.deepEqual(gpuServer.runtimeKinds, ['docker']);
  await screenshot(adminPage, 'global-shared-site');

  console.log('Own settings: an Editor saves an account name and GROUP; their key waits for the launcher');
  const alicePage = alice.page;
  await alicePage.goto(computeOf(sharedProject));
  await alicePage.getByRole('row').filter({ hasText: 'ABCI' }).getByText('全体の計算機').waitFor();
  assert.equal(await alicePage.getByTestId(`target-edit-${abci.id}`).count(), 0);
  await alicePage.getByTestId(`target-details-${abci.id}`).click();
  const aliceDetails = siteDetails(alicePage);
  await aliceDetails
    .getByText('アカウント名を保存するまで、この計算機でJobを作れません', { exact: false })
    .waitFor();
  await aliceDetails.getByText('版1を表示しています').waitFor();
  assert.equal(await aliceDetails.getByRole('button', { name: 'job shellを編集' }).count(), 0);
  assert.equal(await aliceDetails.getByRole('region', { name: '利用者の設定' }).count(), 0);
  await aliceDetails.getByLabel('あなたのアカウント名').fill('acb12345');
  await aliceDetails.getByLabel(PERSONAL_VARIABLES_LABEL).fill('GROUP=gaa50000');
  await aliceDetails.getByRole('button', { name: '自分の設定を保存', exact: true }).click();
  await aliceDetails.getByText('自分の設定を保存しました。').waitFor();
  const ownKey = aliceDetails.locator('.site-personal-key');
  await ownKey.getByText('あなた用の鍵').waitFor();
  await ownKey.getByText('作成待ち', { exact: true }).waitFor();
  await ownKey.getByText('launcherが鍵を作るのを待っています', { exact: false }).waitFor();
  assert.equal(await ownKey.getByRole('button', { name: '接続を確認', exact: true }).isDisabled(), true);
  const saved = (await alice.api.get(`/targets/${abci.id}/personal-settings/me`)).item;
  assert.equal(saved.accountName, 'acb12345');
  assert.deepEqual(saved.variables, { GROUP: 'gaa50000' });
  assert.equal(saved.workDirectory, null);
  assert.equal(saved.key.status, 'requested');
  assert.equal(saved.key.userId, alice.user.id);
  await screenshot(alicePage, 'own-settings-key-requested');
  await alicePage.reload();
  await alicePage.getByTestId(`target-details-${abci.id}`).click();
  assert.equal(await aliceDetails.getByLabel('あなたのアカウント名').inputValue(), 'acb12345');
  assert.equal(await aliceDetails.getByLabel(PERSONAL_VARIABLES_LABEL).inputValue(), 'GROUP=gaa50000');

  console.log('Own settings: the launcher publishes the key and checks the login with that account');
  const launcherConfig = (await withToken(launcherToken, 'GET', '/launcher/config')).body;
  assert.deepEqual(launcherConfig.sites.map((site) => site.target.name).sort(), ['ABCI', 'GPU server']);
  const aliceKey = launcherConfig.keys.find((key) => key.userId === alice.user.id);
  assert.equal(aliceKey.targetId, abci.id);
  assert.equal(aliceKey.status, 'requested');
  const alicePublicKey = sshPublicKey(`mmt-launcher:main:${aliceKey.id}`);
  const published = await withToken(launcherToken, 'PUT', `/launcher/keys/${aliceKey.id}`, {
    publicKey: alicePublicKey,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  await ownKey.getByText(alicePublicKey).waitFor({ timeout: LAUNCHER_ANSWER_TIMEOUT_MS });
  await ownKey
    .getByText('あなたのアカウント（acb12345）の~/.ssh/authorized_keysに1行で追加してください', { exact: false })
    .waitFor();
  await ownKey.getByText('作成済み', { exact: true }).waitFor();
  await ownKey.getByRole('button', { name: '接続を確認', exact: true }).click();
  // The status badges start with a mark (●), so they match by the class and their text.
  await ownKey.locator('.status-badge', { hasText: '確認中' }).waitFor();
  const [check] = (await withToken(launcherToken, 'GET', '/launcher/config')).body.checks;
  assert.equal(check.targetId, abci.id);
  assert.equal(check.account.mode, 'personal');
  assert.equal(check.account.accountName, 'acb12345');
  assert.equal(check.account.keyId, aliceKey.id);
  assert.equal(check.account.workDirectory, '/groups/gaa00000/mmt');
  assert.deepEqual(check.account.variables, { GROUP: 'gaa50000' });
  const reported = await withToken(launcherToken, 'POST', `/launcher/connection-checks/${check.id}`, {
    outcome: 'failed',
    message: 'Permission denied (publickey).',
  });
  assert.equal(reported.status, 204);
  await ownKey.getByText('Permission denied (publickey).').waitFor({ timeout: LAUNCHER_ANSWER_TIMEOUT_MS });
  await ownKey.locator('.status-badge', { hasText: '失敗' }).waitFor();
  await screenshot(alicePage, 'own-settings-key-ready');
  // The site's managers see everyone's settings with the key's state.
  await adminPage.goto(computeOf(sharedProject));
  await adminPage.getByTestId(`target-details-${abci.id}`).click();
  const everyone = adminDetails.getByRole('region', { name: '利用者の設定' });
  const aliceRow = everyone.getByRole('row').filter({ hasText: 'Alice' });
  await aliceRow.getByText('acb12345').waitFor();
  await aliceRow.getByText('GROUP=gaa50000').waitFor();
  await aliceRow.getByText('作成済み').waitFor();

  console.log('Shared account: a researcher gets only the note that there are no own settings');
  await alicePage.goto(computeOf(sharedProject));
  await alicePage.getByTestId(`target-details-${gpuServer.id}`).click();
  await aliceDetails.getByRole('heading', { name: 'GPU server' }).waitFor();
  const noOwnSettings = aliceDetails.getByRole('region', { name: '自分の設定' });
  await noOwnSettings
    .getByText('この計算機は共用アカウントで動くので、自分の設定はありません。', { exact: false })
    .waitFor();
  assert.equal(await noOwnSettings.locator('input, textarea, select, button').count(), 0);
  assert.equal(await aliceDetails.getByRole('region', { name: '鍵と接続確認' }).count(), 0);
  assert.equal(await aliceDetails.getByRole('region', { name: '利用者の設定' }).count(), 0);
  assert.equal(await aliceDetails.getByRole('button', { name: 'job shellを編集' }).count(), 0);
  const refused = await alice.api.raw('PUT', `/targets/${gpuServer.id}/personal-settings/me`, {
    variables: { GROUP: 'gaa50000' },
  });
  assert.equal(refused.status(), 422, 'the API refuses own settings on a shared account');
  await screenshot(alicePage, 'shared-account-no-own-settings');

  console.log('Own PC: a researcher adds a manual PC of their own and shares it with one Project');
  await alicePage.getByRole('button', { name: '計算機を追加', exact: true }).click();
  const pcDialog = openDialog(alicePage);
  await pcDialog.getByText('自分の計算機として追加します', { exact: false }).waitFor();
  assert.equal(await pcDialog.getByLabel('Executor').count(), 0);
  assert.equal(await pcDialog.getByLabel('使える範囲').count(), 0);
  await pcDialog.getByLabel('job shellの雛形').selectOption('direct-docker');
  await pcDialog.getByLabel('投入方式').selectOption('manual');
  assert.equal(await pcDialog.getByLabel('launcher').count(), 0);
  await pcDialog.getByLabel('名前').fill('Alice PC');
  const projectChoices = pcDialog.getByLabel('共有するProject');
  const shareable = await projectChoices.locator('option').allTextContents();
  for (const name of ['Site computers A', 'Site computers B']) assert.ok(shareable.includes(name), shareable.join(', '));
  assert.ok(!shareable.includes('Site computers admin'), shareable.join(', '));
  await projectChoices.selectOption([sharedProject.project.id]);
  await pcDialog.getByLabel(WORK_DIRECTORY_LABEL).fill('/home/alice/mmt');
  await pcDialog.getByRole('button', { name: '保存', exact: true }).click();
  await waitForNoDialog(alicePage);
  const pc = (await alice.api.get('/targets')).items.find((target) => target.name === 'Alice PC');
  assert.equal(pc.ownerUserId, alice.user.id);
  assert.equal(pc.submissionMode, 'manual');
  assert.deepEqual(pc.projectIds, [sharedProject.project.id]);
  assert.deepEqual(pc.runtimeKinds, ['docker']);
  assert.equal(pc.site.connection, null);
  await aliceDetails.getByRole('heading', { name: 'Alice PC' }).waitFor();
  for (const command of ['', ' --watch', ' --watch --all'])
    await aliceDetails.getByText(`mado-tracking submit --site ${pc.id}${command}`, { exact: true }).waitFor();
  await aliceDetails.getByText(ALL_SCOPE_NOTE, { exact: false }).waitFor();
  const pcRow = alicePage.getByRole('row').filter({ hasText: 'Alice PC' });
  await pcRow.getByText('自分の計算機').waitFor();
  await pcRow.getByText('Site computers A', { exact: true }).waitFor();

  console.log('Job shell: an edit saves version 2, and the history shows both versions');
  await aliceDetails.getByText('版1を表示しています').waitFor();
  await aliceDetails.getByRole('button', { name: 'job shellを編集', exact: true }).click();
  const editor = jobShellEditor(aliceDetails);
  assert.equal(await editor.inputValue(), exampleJobShell('direct-docker'));
  const secondShell = exampleJobShell('direct-docker').replace(
    '#!/bin/sh\n',
    '#!/bin/sh\n# Alice PC: GPUs 0-1 only.\n',
  );
  await editor.fill(secondShell);
  await aliceDetails.getByRole('button', { name: '新しい版として保存', exact: true }).click();
  await aliceDetails.getByText('版2を保存しました。これからの投入に使います。').waitFor();
  await aliceDetails.getByText('版2を表示しています').waitFor();
  const history = aliceDetails.locator('.job-shell-history');
  await history.getByRole('row').filter({ hasText: 'v2' }).getByText('今の版').waitFor();
  await history.getByRole('row').filter({ hasText: 'v1' }).getByRole('button', { name: '表示' }).click();
  await aliceDetails.getByText('版1を表示しています').waitFor();
  await aliceDetails.getByRole('button', { name: '今の版を表示', exact: true }).click();
  await aliceDetails.getByText('# Alice PC: GPUs 0-1 only.').waitFor();
  const versions = (await alice.api.get(`/targets/${pc.id}/job-shells`)).items;
  assert.deepEqual(versions.map((version) => [version.version, version.createdByName]), [
    [2, 'Alice'],
    [1, 'Alice'],
  ]);
  await screenshot(alicePage, 'own-pc-job-shell-history');

  console.log('Sharing: another member chooses the PC in the shared Project, and not in the other');
  const bobPage = bob.page;
  const sharedChoices = await openTargetChoices(bobPage, { project: sharedProject, runName: 'on-alice-pc' });
  assert.ok(sharedChoices.choices.some(isChoiceOf('Alice PC')), sharedChoices.choices.join(', '));
  await sharedChoices.targetSelect.selectOption(pc.id);
  await sharedChoices.dialog.getByRole('button', { name: '次へ', exact: true }).click();
  await sharedChoices.dialog.getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  await waitForNoDialog(bobPage);
  const otherChoices = await openTargetChoices(bobPage, { project: otherProject, runName: 'elsewhere' });
  // The global GPU host takes the same container runtime, so the list itself is there.
  assert.ok(otherChoices.choices.some(isChoiceOf('GPU server')), otherChoices.choices.join(', '));
  assert.ok(!otherChoices.choices.some(isChoiceOf('Alice PC')), otherChoices.choices.join(', '));
  await screenshot(bobPage, 'other-project-target-choices');
  await otherChoices.dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  const bobTargets = async (project) =>
    (await bob.api.get(`/targets?projectId=${project.project.id}`)).items.map((target) => target.name);
  assert.ok((await bobTargets(sharedProject)).includes('Alice PC'));
  assert.ok(!(await bobTargets(otherProject)).includes('Alice PC'));
  const refusedJob = await bob.api.raw('POST', `/projects/${otherProject.project.id}/jobs`, {
    runId: (
      await bob.api.post(`/projects/${otherProject.project.id}/runs`, {
        experimentId: otherProject.experiment.id,
        name: 'not-shared',
        kind: 'training',
        codeVersionId: otherProject.codeVersion.id,
      })
    ).id,
    targetId: pc.id,
  });
  assert.equal(refusedJob.status(), 422);
  assert.equal((await refusedJob.json()).code, 'target_not_available');

  console.log('Manual submission: the Job waits for mado-tracking submit; its owner also gets --all');
  const [job] = (await bob.api.get(`/projects/${sharedProject.project.id}/jobs`)).items;
  assert.equal(job.targetId, pc.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.phase, 'waiting_manual');
  await bobPage.goto(`${WEB_URL}/projects/${sharedProject.project.id}/jobs?job=${job.id}`);
  const waiting = bobPage.getByRole('region', { name: '手動投入を待っているJob' });
  await waiting.getByText('Alice PC: 1件').waitFor();
  // Bob gets the command for his own Jobs, and that Alice's side submits them where she waits.
  await waiting.getByText(`mado-tracking submit --site ${pc.id}`, { exact: true }).waitFor();
  await waiting.getByText(OWNER_SUBMITS_NOTE('Alice')).waitFor();
  const bobJob = bobPage.locator('.job-detail');
  await bobJob.getByText('手動投入待ち').first().waitFor();
  await bobJob.getByText('あなたが依頼したJobです。', { exact: false }).waitFor();
  await bobJob.getByText(`mado-tracking submit --site ${pc.id}`, { exact: true }).waitFor();
  await bobJob.getByText(OWNER_SUBMITS_NOTE('Alice')).waitFor();
  assert.equal(await bobPage.locator('code', { hasText: '--all' }).count(), 0, 'only the owner may use --all');
  await screenshot(bobPage, 'manual-job-requester');
  // The computer's details tell Bob the same next to the commands he may run.
  await bobPage.goto(computeOf(sharedProject));
  await bobPage.getByRole('row').filter({ hasText: 'Alice PC' }).getByText('Aliceさんの計算機').waitFor();
  await bobPage.getByTestId(`target-details-${pc.id}`).click();
  const bobDetails = siteDetails(bobPage);
  for (const command of ['', ' --watch'])
    await bobDetails.getByText(`mado-tracking submit --site ${pc.id}${command}`, { exact: true }).waitFor();
  await bobDetails.getByText(OWNER_SUBMITS_NOTE('Alice')).waitFor();
  assert.equal(await bobDetails.locator('code', { hasText: '--all' }).count(), 0);
  assert.equal(await bobDetails.getByText(ALL_SCOPE_NOTE, { exact: false }).count(), 0);
  await screenshot(bobPage, 'others-pc-details');
  await alicePage.goto(`${WEB_URL}/projects/${sharedProject.project.id}/jobs?job=${job.id}`);
  const ownerWaiting = alicePage.getByRole('region', { name: '手動投入を待っているJob' });
  await ownerWaiting.getByText('Alice PC: 1件').waitFor();
  await ownerWaiting
    .getByText(`mado-tracking submit --site ${pc.id} --watch --all`, { exact: true })
    .waitFor();
  await ownerWaiting.getByText(ALL_SCOPE_NOTE, { exact: false }).waitFor();
  const ownerJob = alicePage.locator('.job-detail');
  await ownerJob.getByText(`mado-tracking submit --site ${pc.id} --watch --all`, { exact: true }).waitFor();
  await ownerJob.getByText(ALL_SCOPE_NOTE, { exact: false }).waitFor();
  // The owner is not told that the owner submits.
  assert.equal(await alicePage.getByText('さんの計算機です。', { exact: false }).count(), 0);
  await screenshot(alicePage, 'manual-job-owner');

  console.log('Manual submission: `submit --all` by the owner records the job shell version it used');
  // A token that writes belongs to one Project; --all takes that Project's Jobs on the PC.
  const { token: aliceToken } = await alice.api.post('/tokens', {
    name: 'Alice PC submit',
    kind: 'personal',
    projectId: sharedProject.project.id,
    scopes: ['read', 'jobs:write'],
  });
  const bobsOnly = await withToken(aliceToken, 'POST', '/manual-submissions/claim', {
    targetId: pc.id,
    submitterId: 'alice-pc',
  });
  assert.deepEqual(bobsOnly.body.items, [], 'without --all the owner takes only their own Jobs');
  const claimed = await withToken(aliceToken, 'POST', '/manual-submissions/claim', {
    targetId: pc.id,
    submitterId: 'alice-pc',
    all: true,
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const [submission] = claimed.body.items;
  assert.equal(submission.jobShell.version, 2);
  assert.equal(submission.jobShell.content, secondShell);
  assert.equal(submission.account.workDirectory, '/home/alice/mmt');
  const submitted = await withToken(aliceToken, 'POST', '/manual-submissions/report', {
    submitterId: 'alice-pc',
    results: [{ jobIds: submission.jobs.map((item) => item.job.id), outcome: 'submitted', schedulerJobId: 'docker-1' }],
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  await bobPage.goto(`${WEB_URL}/projects/${sharedProject.project.id}/jobs?job=${job.id}`);
  await bobJob.getByText('job shellの版').waitFor();
  await bobJob.getByText('v2', { exact: true }).waitFor();
  assert.equal(await bobPage.getByRole('region', { name: '手動投入を待っているJob' }).count(), 0);

  console.log("Sharing edits: the choices are the owner's Projects, also for a global administrator");
  // A global administrator editing Alice's PC is offered Alice's Projects, not their own.
  await adminPage.goto(computeOf(sharedProject));
  await adminPage.getByTestId(`target-edit-${pc.id}`).click();
  const adminEdit = openDialog(adminPage);
  const adminChoices = adminEdit.getByLabel('共有するProject');
  await adminChoices.waitFor();
  assert.deepEqual((await adminChoices.locator('option').allTextContents()).sort(), [
    'Site computers A',
    'Site computers B',
  ]);
  await adminEdit.getByText('選べるのは、所有者がEditor以上のProjectです。', { exact: false }).waitFor();
  await adminEdit.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await waitForNoDialog(adminPage);
  assert.ok((await admin.api.get('/projects')).items.some((project) => project.id === adminOnlyProject.id));
  /** Alice's edit of her PC's sharing: the choices and those selected when it opened. */
  async function editSharing(projectIds) {
    await alicePage.goto(computeOf(sharedProject));
    await alicePage.getByTestId(`target-edit-${pc.id}`).click();
    const dialog = openDialog(alicePage);
    const choices = dialog.getByLabel('共有するProject');
    await choices.waitFor();
    const offered = await choices.locator('option').allTextContents();
    const selected = await choices.locator('option:checked').allTextContents();
    await choices.selectOption(projectIds);
    // A Job on the PC is still unfinished; an edit that keeps how it runs is accepted.
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await waitForNoDialog(alicePage);
    return { offered: offered.sort(), selected: selected.sort() };
  }
  const sharedPcProjects = async () =>
    (await alice.api.get('/targets')).items.find((target) => target.id === pc.id).projectIds.sort();
  const firstEdit = await editSharing([sharedProject.project.id, otherProject.project.id]);
  assert.deepEqual(firstEdit.offered, ['Site computers A', 'Site computers B']);
  assert.deepEqual(firstEdit.selected, ['Site computers A']);
  await alicePage.getByRole('row').filter({ hasText: 'Alice PC' }).getByText('Site computers B', { exact: false }).waitFor();
  assert.deepEqual(await sharedPcProjects(), [sharedProject.project.id, otherProject.project.id].sort());
  assert.ok((await bobTargets(otherProject)).includes('Alice PC'));
  const nowShared = await openTargetChoices(bobPage, { project: otherProject, runName: 'now-shared' });
  assert.ok(nowShared.choices.some(isChoiceOf('Alice PC')), nowShared.choices.join(', '));
  await nowShared.dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  // Once Alice is only a viewer of B, B stays among her choices, marked, so she can take it off.
  await admin.api.put(`/projects/${otherProject.project.id}/members/${alice.user.id}`, { role: 'viewer' });
  const secondEdit = await editSharing([sharedProject.project.id]);
  assert.deepEqual(secondEdit.offered, ['Site computers A', `Site computers B${NO_LONGER_SHAREABLE}`]);
  assert.deepEqual(secondEdit.selected, ['Site computers A', `Site computers B${NO_LONGER_SHAREABLE}`]);
  assert.deepEqual(await sharedPcProjects(), [sharedProject.project.id]);
  assert.ok(!(await bobTargets(otherProject)).includes('Alice PC'));
  await screenshot(alicePage, 'sharing-edited');

  console.log('Phone width: the details, the Jobs and the launchers stay within the screen');
  for (const page of [alicePage, bobPage, adminPage]) await page.setViewportSize({ width: PHONE_WIDTH, height: 844 });
  await alicePage.goto(computeOf(sharedProject));
  await alicePage.getByTestId(`target-details-${pc.id}`).click();
  await aliceDetails.getByText('版2を表示しています').waitFor();
  await assertNoSidewaysScroll(alicePage, 'own PC details');
  await screenshot(alicePage, 'phone-own-pc');
  await alicePage.getByTestId(`target-details-${abci.id}`).click();
  await aliceDetails.locator('.site-personal-key').getByText(alicePublicKey).waitFor();
  await assertNoSidewaysScroll(alicePage, 'own settings and key');
  await screenshot(alicePage, 'phone-own-settings');
  // The dialog fills the screen on a phone, so it must not be wider than the screen either.
  await alicePage.getByRole('button', { name: '計算機を追加', exact: true }).click();
  const phoneDialog = openDialog(alicePage);
  await phoneDialog.getByLabel('job shellの雛形').selectOption('pbs');
  const dialogOverflow = await phoneDialog.evaluate((element) => element.scrollWidth - element.clientWidth);
  assert.ok(dialogOverflow <= 0, `the target dialog scrolls sideways by ${dialogOverflow}px`);
  await screenshot(alicePage, 'phone-target-dialog');
  await phoneDialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await waitForNoDialog(alicePage);
  await alicePage.goto(`${WEB_URL}/projects/${sharedProject.project.id}/jobs?job=${job.id}`);
  await alicePage.locator('.job-detail').getByText('job shellの版').waitFor();
  await assertNoSidewaysScroll(alicePage, 'Job details');
  await adminPage.goto(`${WEB_URL}/admin`);
  await adminPage.getByRole('tab', { name: 'launcher', exact: true }).click();
  await adminPage.getByText('main', { exact: true }).first().waitFor();
  await assertNoSidewaysScroll(adminPage, 'launchers');
  await screenshot(adminPage, 'phone-launchers');

  console.log('Launcher: revoking it stops its token');
  await adminPage.setViewportSize(DESKTOP);
  await adminPage.getByRole('button', { name: '失効させる', exact: true }).click();
  await openDialog(adminPage).getByRole('button', { name: '失効させる', exact: true }).click();
  await waitForNoDialog(adminPage);
  await adminPage.getByRole('row').filter({ hasText: 'main' }).getByText('失効', { exact: true }).waitFor();
  assert.equal(await adminPage.getByRole('button', { name: 'tokenを作り直す', exact: true }).count(), 0);
  assert.equal((await withToken(launcherToken, 'GET', '/launcher/config')).status, 401);
  await screenshot(adminPage, 'launcher-revoked');

  assert.deepEqual(pageErrors, []);
  console.log('Browser site computers against the real API passed');
} catch (failure) {
  // Keep what each open page showed when a step failed.
  for (const [index, page] of browser.contexts().flatMap((context) => context.pages()).entries()) {
    console.error(`failure at ${page.url()}`);
    await screenshot(page, `failure-${index}`).catch(() => undefined);
  }
  console.error('page errors:', pageErrors);
  console.error('console errors:', consoleErrors);
  throw failure;
} finally {
  await browser.close();
  await application?.outbox.stop();
  await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await database.end();
  await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
  await administrator.end();
  await rm(artifactDirectory, { recursive: true, force: true });
}
