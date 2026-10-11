// Browser check of computers added on the Web (launchers, sites, job shells, personal settings,
// visibility, manual submission) against an isolated API in development mode (port 47140) and Vite
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
  `このコンピュータは${owner}さんのコンピュータです。所有者が--watch --allで待ち受けているコンピュータ（所有者のPCなど）では、所有者の側で投入されます。`;
const PERSONAL_VARIABLES_LABEL = '変数（任意。NAME=VALUEを1行に1つ。コンピュータの変数より優先します）';
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
  const field = dialog.getByLabel('ランチャーのtoken', { exact: true });
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

const visibilityChoice = (dialog, name) => dialog.getByRole('radio', { name, exact: false });

/**
 * Fills a global administrator's dialog for an automatic public site from a template, with the
 * values each example's README lists for the Web; the caller saves it.
 */
async function addPublicSite(page, site) {
  await page.getByRole('button', { name: 'コンピュータを追加', exact: true }).click();
  const dialog = openDialog(page);
  await dialog.getByLabel('Executor').selectOption('site');
  // Private unless chosen otherwise; these serve everyone.
  assert.equal(await visibilityChoice(dialog, 'Private').isChecked(), true);
  await visibilityChoice(dialog, 'Public').check();
  await dialog.getByLabel('job shellの雛形').selectOption(site.template);
  assert.equal(await jobShellEditor(dialog).inputValue(), exampleJobShell(site.template));
  await dialog.getByLabel('名前').fill(site.name);
  await dialog.getByLabel('ランチャー').selectOption(site.launcherId);
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
  await dialog.getByLabel('コードバージョン').selectOption(project.codeVersion.id);
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
  const admin = await signIn(ADMIN_EMAIL, 'コンピュータの管理者');
  assert.equal(admin.user.isAdmin, true);
  const alice = await signIn('sites-alice@localhost', 'Alice');
  const bob = await signIn('sites-bob@localhost', 'Bob');
  async function createProject(name) {
    const project = await admin.api.post('/projects', { name });
    const experiment = await admin.api.post(`/projects/${project.id}/experiments`, { name: 'コンピュータの検証' });
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
  // Bob runs Jobs in both Projects; a public computer serves every Project alike.
  const sharedProject = await createProject('Site computers A');
  const otherProject = await createProject('Site computers B');
  const computersPage = `${WEB_URL}/settings/computers`;
  const computerRow = (page, name) => page.getByRole('row').filter({ hasText: name });

  console.log('Launcher: a global administrator registers one; the token is shown once');
  const adminPage = admin.page;
  await adminPage.goto(`${WEB_URL}/settings/launchers`);
  await adminPage.getByText('ランチャーはまだ登録されていません。').waitFor();
  await adminPage.getByRole('button', { name: 'ランチャーを登録', exact: true }).click();
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

  console.log('Public sites: PBS with each person\'s own account, and a GPU host on a shared account');
  await adminPage.goto(computersPage);
  const pbsDialog = await addPublicSite(adminPage, {
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
  await adminDetails.getByText('バージョン1を表示しています').waitFor();
  await adminDetails
    .getByRole('region', { name: '利用者の設定' })
    .getByText('このコンピュータの設定を保存した人はまだいません。')
    .waitFor();
  const abci = (await admin.api.get('/targets')).items.find((target) => target.name === 'ABCI');
  // Whoever adds a computer owns it, a global administrator too.
  assert.equal(abci.ownerUserId, admin.user.id);
  assert.equal(abci.visibility, 'public');
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

  const gpuDialog = await addPublicSite(adminPage, {
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
  await sharedKeys.getByText('ランチャーが鍵を作るのを待っています', { exact: false }).waitFor();
  await sharedKeys.getByText('作成待ち', { exact: true }).waitFor();
  // The API refuses a login check until the launcher has made the key (site_check_unavailable).
  assert.equal(await sharedKeys.getByRole('button', { name: '接続を確認', exact: true }).isDisabled(), true);
  const gpuServer = (await admin.api.get('/targets')).items.find((target) => target.name === 'GPU server');
  assert.equal(gpuServer.siteAccountMode, 'shared');
  assert.deepEqual(gpuServer.runtimeKinds, ['docker']);
  await screenshot(adminPage, 'global-shared-site');

  console.log('Own settings: an Editor saves an account name and GROUP; their key waits for the launcher');
  const alicePage = alice.page;
  await alicePage.goto(computersPage);
  await computerRow(alicePage, 'ABCI').getByText('コンピュータの管理者').waitFor();
  await computerRow(alicePage, 'ABCI').getByText('Public').waitFor();
  assert.equal(await alicePage.getByTestId(`target-edit-${abci.id}`).count(), 0);
  await alicePage.getByTestId(`target-details-${abci.id}`).click();
  const aliceDetails = siteDetails(alicePage);
  await aliceDetails
    .getByText('アカウント名を保存するまで、このコンピュータでJobを作れません', { exact: false })
    .waitFor();
  await aliceDetails.getByText('バージョン1を表示しています').waitFor();
  assert.equal(await aliceDetails.getByRole('button', { name: 'job shellを編集' }).count(), 0);
  assert.equal(await aliceDetails.getByRole('region', { name: '利用者の設定' }).count(), 0);
  await aliceDetails.getByLabel('あなたのアカウント名').fill('acb12345');
  await aliceDetails.getByLabel(PERSONAL_VARIABLES_LABEL).fill('GROUP=gaa50000');
  await aliceDetails.getByRole('button', { name: '自分の設定を保存', exact: true }).click();
  await aliceDetails.getByText('自分の設定を保存しました。').waitFor();
  const ownKey = aliceDetails.locator('.site-personal-key');
  await ownKey.getByText('あなた用の鍵').waitFor();
  await ownKey.getByText('作成待ち', { exact: true }).waitFor();
  await ownKey.getByText('ランチャーが鍵を作るのを待っています', { exact: false }).waitFor();
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
  await adminPage.goto(computersPage);
  await adminPage.getByTestId(`target-details-${abci.id}`).click();
  const everyone = adminDetails.getByRole('region', { name: '利用者の設定' });
  const aliceRow = everyone.getByRole('row').filter({ hasText: 'Alice' });
  await aliceRow.getByText('acb12345').waitFor();
  await aliceRow.getByText('GROUP=gaa50000').waitFor();
  await aliceRow.getByText('作成済み').waitFor();

  console.log('Shared account: a researcher gets only the note that there are no own settings');
  await alicePage.goto(computersPage);
  await alicePage.getByTestId(`target-details-${gpuServer.id}`).click();
  await aliceDetails.getByRole('heading', { name: 'GPU server' }).waitFor();
  const noOwnSettings = aliceDetails.getByRole('region', { name: '自分の設定' });
  await noOwnSettings
    .getByText('このコンピュータは共用アカウントで動くので、自分の設定はありません。', { exact: false })
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

  console.log('Own PC: a researcher adds a manual PC of their own, private by default');
  await alicePage.getByRole('button', { name: 'コンピュータを追加', exact: true }).click();
  const pcDialog = openDialog(alicePage);
  await pcDialog.getByText('追加した人が所有者になります', { exact: false }).waitFor();
  assert.equal(await pcDialog.getByLabel('Executor').count(), 0);
  assert.equal(await pcDialog.getByLabel('共有するProject').count(), 0);
  assert.equal(await visibilityChoice(pcDialog, 'Private').isChecked(), true);
  await pcDialog.getByLabel('job shellの雛形').selectOption('direct-docker');
  await pcDialog.getByLabel('投入方式').selectOption('manual');
  assert.equal(await pcDialog.getByLabel('ランチャー').count(), 0);
  await pcDialog.getByLabel('名前').fill('Alice PC');
  await pcDialog.getByLabel(WORK_DIRECTORY_LABEL).fill('/home/alice/mmt');
  await screenshot(alicePage, 'own-pc-dialog');
  await pcDialog.getByRole('button', { name: '保存', exact: true }).click();
  await waitForNoDialog(alicePage);
  const pc = (await alice.api.get('/targets')).items.find((target) => target.name === 'Alice PC');
  assert.equal(pc.ownerUserId, alice.user.id);
  assert.equal(pc.visibility, 'private');
  assert.equal(pc.submissionMode, 'manual');
  assert.deepEqual(pc.runtimeKinds, ['docker']);
  assert.equal(pc.site.connection, null);
  await aliceDetails.getByRole('heading', { name: 'Alice PC' }).waitFor();
  for (const command of ['', ' --watch', ' --watch --all'])
    await aliceDetails.getByText(`mado-tracking submit --site ${pc.id}${command}`, { exact: true }).waitFor();
  await aliceDetails.getByText(ALL_SCOPE_NOTE, { exact: false }).waitFor();
  const pcRow = computerRow(alicePage, 'Alice PC');
  await pcRow.getByText('自分', { exact: true }).waitFor();
  await pcRow.getByText('Private').waitFor();

  console.log('Job shell: an edit saves version 2, and the history shows both versions');
  await aliceDetails.getByText('バージョン1を表示しています').waitFor();
  await aliceDetails.getByRole('button', { name: 'job shellを編集', exact: true }).click();
  const editor = jobShellEditor(aliceDetails);
  assert.equal(await editor.inputValue(), exampleJobShell('direct-docker'));
  const secondShell = exampleJobShell('direct-docker').replace(
    '#!/bin/sh\n',
    '#!/bin/sh\n# Alice PC: GPUs 0-1 only.\n',
  );
  await editor.fill(secondShell);
  await aliceDetails.getByRole('button', { name: '新しいバージョンとして保存', exact: true }).click();
  await aliceDetails.getByText('バージョン2を保存しました。これからの投入に使います。').waitFor();
  await aliceDetails.getByText('バージョン2を表示しています').waitFor();
  const history = aliceDetails.locator('.job-shell-history');
  await history.getByRole('row').filter({ hasText: 'v2' }).getByText('今のバージョン').waitFor();
  await history.getByRole('row').filter({ hasText: 'v1' }).getByRole('button', { name: '表示' }).click();
  await aliceDetails.getByText('バージョン1を表示しています').waitFor();
  await aliceDetails.getByRole('button', { name: '今のバージョンを表示', exact: true }).click();
  await aliceDetails.getByText('# Alice PC: GPUs 0-1 only.').waitFor();
  const versions = (await alice.api.get(`/targets/${pc.id}/job-shells`)).items;
  assert.deepEqual(versions.map((version) => [version.version, version.createdByName]), [
    [2, 'Alice'],
    [1, 'Alice'],
  ]);
  await screenshot(alicePage, 'own-pc-job-shell-history');

  console.log("Private: another member sees the PC listed, but neither opens it nor runs Jobs on it");
  const bobPage = bob.page;
  await bobPage.goto(computersPage);
  const privateRow = computerRow(bobPage, 'Alice PC');
  await privateRow.getByText('Private').waitFor();
  await privateRow.getByText('使えない').waitFor();
  assert.equal(await bobPage.getByTestId(`target-details-${pc.id}`).count(), 0);
  assert.equal(await bobPage.getByText('/home/alice/mmt').count(), 0);
  await screenshot(bobPage, 'others-private-pc-listed');
  const privateChoices = await openTargetChoices(bobPage, { project: sharedProject, runName: 'not-yet' });
  assert.ok(privateChoices.choices.some(isChoiceOf('GPU server')), privateChoices.choices.join(', '));
  assert.ok(!privateChoices.choices.some(isChoiceOf('Alice PC')), privateChoices.choices.join(', '));
  await privateChoices.dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  const bobTargets = async (project) =>
    (await bob.api.get(`/targets?projectId=${project.project.id}`)).items.map((target) => target.name);
  const refusedJob = await bob.api.raw('POST', `/projects/${otherProject.project.id}/jobs`, {
    runId: (
      await bob.api.post(`/projects/${otherProject.project.id}/runs`, {
        experimentId: otherProject.experiment.id,
        name: 'private-pc',
        kind: 'training',
        codeVersionId: otherProject.codeVersion.id,
      })
    ).id,
    targetId: pc.id,
  });
  assert.equal(refusedJob.status(), 422);
  assert.equal((await refusedJob.json()).code, 'target_not_available');

  console.log('Public: the owner opens the PC to everyone, and every Project may run on it');
  await alicePage.goto(computersPage);
  await alicePage.getByTestId(`target-edit-${pc.id}`).click();
  const visibilityEdit = openDialog(alicePage);
  await visibilityChoice(visibilityEdit, 'Public').check();
  // A Job on the PC may be unfinished; an edit that keeps how it runs is accepted.
  await visibilityEdit.getByRole('button', { name: '保存', exact: true }).click();
  await waitForNoDialog(alicePage);
  await computerRow(alicePage, 'Alice PC').getByText('Public').waitFor();
  assert.ok((await bobTargets(sharedProject)).includes('Alice PC'));
  assert.ok((await bobTargets(otherProject)).includes('Alice PC'));
  const publicChoices = await openTargetChoices(bobPage, { project: sharedProject, runName: 'on-alice-pc' });
  assert.ok(publicChoices.choices.some(isChoiceOf('Alice PC')), publicChoices.choices.join(', '));
  await publicChoices.targetSelect.selectOption(pc.id);
  await publicChoices.dialog.getByRole('button', { name: '次へ', exact: true }).click();
  await publicChoices.dialog.getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  await waitForNoDialog(bobPage);

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
  await bobPage.goto(computersPage);
  await computerRow(bobPage, 'Alice PC').getByText('Alice', { exact: true }).waitFor();
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
  assert.equal(await alicePage.getByText('さんのコンピュータです。', { exact: false }).count(), 0);
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
  await bobJob.getByText('job shellのバージョン').waitFor();
  await bobJob.getByText('v2', { exact: true }).waitFor();
  assert.equal(await bobPage.getByRole('region', { name: '手動投入を待っているJob' }).count(), 0);

  console.log("Visibility: a global administrator manages Alice's PC; once private, Bob's Projects lose it");
  await adminPage.goto(computersPage);
  await adminPage.getByTestId(`target-edit-${pc.id}`).click();
  const adminEdit = openDialog(adminPage);
  assert.equal(await visibilityChoice(adminEdit, 'Public').isChecked(), true);
  await adminEdit.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await waitForNoDialog(adminPage);
  await alicePage.goto(computersPage);
  await alicePage.getByTestId(`target-edit-${pc.id}`).click();
  const closeEdit = openDialog(alicePage);
  await visibilityChoice(closeEdit, 'Private').check();
  await closeEdit.getByRole('button', { name: '保存', exact: true }).click();
  await waitForNoDialog(alicePage);
  await computerRow(alicePage, 'Alice PC').getByText('Private').waitFor();
  assert.ok(!(await bobTargets(sharedProject)).includes('Alice PC'));
  assert.ok(!(await bobTargets(otherProject)).includes('Alice PC'));
  const audits = await admin.api.get('/audit-events?action=compute_target.update');
  assert.ok(
    audits.items.some((event) => event.resourceId === pc.id && event.details?.visibility?.to === 'private'),
    'the visibility change is audited',
  );
  await screenshot(alicePage, 'visibility-private-again');

  console.log('Phone width: the details, the Jobs and the launchers stay within the screen');
  for (const page of [alicePage, bobPage, adminPage]) await page.setViewportSize({ width: PHONE_WIDTH, height: 844 });
  await alicePage.goto(computersPage);
  await alicePage.getByTestId(`target-details-${pc.id}`).click();
  await aliceDetails.getByText('バージョン2を表示しています').waitFor();
  await assertNoSidewaysScroll(alicePage, 'own PC details');
  await screenshot(alicePage, 'phone-own-pc');
  await alicePage.getByTestId(`target-details-${abci.id}`).click();
  await aliceDetails.locator('.site-personal-key').getByText(alicePublicKey).waitFor();
  await assertNoSidewaysScroll(alicePage, 'own settings and key');
  await screenshot(alicePage, 'phone-own-settings');
  // The dialog fills the screen on a phone, so it must not be wider than the screen either.
  await alicePage.getByRole('button', { name: 'コンピュータを追加', exact: true }).click();
  const phoneDialog = openDialog(alicePage);
  await phoneDialog.getByLabel('job shellの雛形').selectOption('pbs');
  const dialogOverflow = await phoneDialog.evaluate((element) => element.scrollWidth - element.clientWidth);
  assert.ok(dialogOverflow <= 0, `the target dialog scrolls sideways by ${dialogOverflow}px`);
  await screenshot(alicePage, 'phone-target-dialog');
  await phoneDialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await waitForNoDialog(alicePage);
  await alicePage.goto(`${WEB_URL}/projects/${sharedProject.project.id}/jobs?job=${job.id}`);
  await alicePage.locator('.job-detail').getByText('job shellのバージョン').waitFor();
  await assertNoSidewaysScroll(alicePage, 'Job details');
  await adminPage.goto(`${WEB_URL}/settings/launchers`);
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
