// Browser test of computers added on the Web (site settings, job shells, keys and checks, personal
// settings, launchers) against the isolated mock API. Run it like the other browser tests, with
// the dev server on MMT_WEB_URL; MMT_SCREENSHOT_DIR, when set, receives screenshots.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
// The templates the dialog offers are the deploy/sites examples as they are.
const exampleJobShell = (key) =>
  readFileSync(new URL(`../../../deploy/sites/examples/${key}/job.sh`, import.meta.url), 'utf8');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const api = createBrowserApi();
api.state.loggedIn = true;
const now = '2026-10-10T00:00:00Z';
let sequence = 5000;
const id = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;

// What the API keeps for sites beyond the targets: job shell versions, keys, checks, settings.
const site = { jobShells: new Map(), keys: [], checks: [], personal: new Map() };
const summary = ({ content: _content, ...rest }) => rest;
function saveJobShell(targetId, content) {
  const versions = site.jobShells.get(targetId) ?? [];
  const current = versions[0];
  if (current?.content === content) return { shell: current, status: 200 };
  const shell = {
    id: id(),
    targetId,
    version: (current?.version ?? 0) + 1,
    sha256: createHash('sha256').update(content).digest('hex'),
    sizeBytes: Buffer.byteLength(content),
    createdBy: api.state.user.id,
    createdByName: api.state.user.displayName,
    createdAt: now,
    content,
  };
  site.jobShells.set(targetId, [shell, ...versions]);
  const target = api.state.targets.find((item) => item.id === targetId);
  if (target?.site) target.site.jobShell = summary(shell);
  return { shell, status: 201 };
}
function requestKey(targetId, userId) {
  site.keys = site.keys.filter((key) => !(key.targetId === targetId && key.userId === userId));
  const key = {
    id: id(),
    targetId,
    userId,
    launcherId: api.state.launchers[0]?.id ?? id(),
    status: 'requested',
    publicKey: null,
    fingerprint: null,
    requestedAt: now,
    readyAt: null,
  };
  site.keys.push(key);
  return key;
}
// The launcher's part: after a read, the requested keys are made for the next one.
function makeRequestedKeys() {
  for (const key of site.keys)
    if (key.status === 'requested')
      Object.assign(key, {
        status: 'ready',
        publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${key.id.slice(-4)} mmt-launcher:main:${key.id}`,
        fingerprint: `SHA256:${key.id.slice(-8)}`,
        readyAt: now,
      });
}

// GET /targets/shareable-projects answers one's own Projects (adding a computer), and
// GET /targets/:id/shareable-projects its owner's; a step changes the owner's or makes them
// unreadable.
const ownProjects = [{ id: api.state.project.id, name: api.state.project.name }];
let ownerProjects = ownProjects;

const calls = [];
await context.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    const body = request.headers()['content-type']?.includes('application/json')
      ? request.postDataJSON()
      : {};
    const reply = (payload, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    const noContent = () => route.fulfill({ status: 204, body: '' });
    const user = api.state.user;
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'targets' || parts[0] === 'launchers')
      calls.push({ method, path, search: url.search, body });
    if (path === '/targets' && method === 'POST') {
      const { personal, projectIds, jobShell, site: settings, ...fields } = body;
      const target = {
        id: id(),
        ...fields,
        ownerUserId: personal ? user.id : null,
        ownerName: personal ? user.displayName : null,
        projectIds: personal ? (projectIds ?? []) : [],
        site: settings ? { ...settings, jobShell: null } : null,
        siteAccountMode: settings ? settings.accountMode : null,
      };
      api.state.targets.push(target);
      if (jobShell) saveJobShell(target.id, jobShell);
      if (settings?.accountMode === 'shared' && settings.launcherId) requestKey(target.id, null);
      return reply(target, 201);
    }
    // Before the /targets/:id routes, as in the API.
    if (path === '/targets/shareable-projects' && method === 'GET')
      return reply({ items: ownProjects });
    if (parts[0] === 'targets' && parts.length >= 2) {
      const target = api.state.targets.find((item) => item.id === parts[1]);
      const [, , resource, key] = parts;
      if (!resource && method === 'PATCH') {
        const { site: settings, ...fields } = body;
        Object.assign(target, fields);
        if (settings) target.site = { ...target.site, ...settings };
        return reply(target);
      }
      if (resource === 'projects' && method === 'PUT') {
        target.projectIds = body.projectIds;
        return reply(target);
      }
      if (resource === 'shareable-projects' && method === 'GET')
        return ownerProjects
          ? reply({ items: ownerProjects })
          : reply({ error: 'ComputeTargetが見つかりません', code: 'not_found' }, 404);
      if (resource === 'job-shells') {
        const versions = site.jobShells.get(target.id) ?? [];
        if (method === 'GET' && !key) return reply({ items: versions.map(summary) });
        if (method === 'GET') return reply(versions.find((shell) => shell.id === key));
        const { shell, status } = saveJobShell(target.id, body.content);
        return reply(shell, status);
      }
      if (resource === 'keys') {
        if (key === 'rotate') return reply(requestKey(target.id, body.personal ? user.id : null));
        const answered = reply({ items: site.keys.filter((item) => item.targetId === target.id) });
        makeRequestedKeys();
        return answered;
      }
      if (resource === 'connection-checks') {
        const personal = url.searchParams.get('personal') === 'true';
        if (method === 'GET')
          return reply({
            items: site.checks.filter(
              (check) => check.targetId === target.id && (check.userId !== null) === personal,
            ),
          });
        const check = {
          id: id(),
          targetId: target.id,
          userId: body.personal ? user.id : null,
          requestedBy: user.id,
          status: 'failed',
          message: 'Permission denied (publickey).',
          createdAt: now,
          finishedAt: now,
        };
        site.checks.unshift(check);
        return reply(check, 201);
      }
      if (resource === 'personal-settings') {
        if (!key)
          return reply({
            items: [...site.personal.values()].filter((item) => item.targetId === target.id),
          });
        const mine = `${target.id}:${user.id}`;
        if (method === 'GET') {
          const answered = reply({ item: site.personal.get(mine) ?? null });
          makeRequestedKeys();
          return answered;
        }
        if (method === 'DELETE') {
          site.personal.delete(mine);
          return noContent();
        }
        const saved = {
          targetId: target.id,
          userId: user.id,
          userName: user.displayName,
          accountName: body.accountName ?? '',
          workDirectory: body.workDirectory ?? null,
          variables: body.variables ?? {},
          key: body.accountName ? requestKey(target.id, user.id) : null,
          updatedAt: now,
        };
        site.personal.set(mine, saved);
        return reply(saved);
      }
    }
    if (path === '/launchers' && method === 'POST') {
      const launcher = {
        id: id(),
        name: body.name,
        createdBy: user.id,
        createdAt: now,
        lastSeenAt: null,
        revokedAt: null,
        tokenPrefix: 'mmt_abcdefgh',
      };
      api.state.launchers.push(launcher);
      return reply({ launcher, token: `mmt_browser_launcher_${launcher.id.slice(-4)}` }, 201);
    }
    if (parts[0] === 'launchers' && parts[2] === 'token' && method === 'POST')
      return reply(
        { launcher: api.state.launchers.find((item) => item.id === parts[1]), token: 'mmt_browser_rotated' },
        201,
      );
    if (parts[0] === 'launchers' && parts.length === 2 && method === 'DELETE') {
      api.state.launchers.find((item) => item.id === parts[1]).revokedAt = now;
      return noContent();
    }
    return api.route(route);
  },
);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const projectBase = `${base}/projects/${api.state.project.id}`;
const dialog = () => page.getByRole('dialog').last();
// Labels of required fields end with an asterisk, so they match by their start like the suite does.
const fill = (label, value) => dialog().getByLabel(label).fill(value);
const select = (label, value) => dialog().getByLabel(label).selectOption(value);
const jobShellEditor = (scope) => scope.getByRole('textbox', { name: 'job shell', exact: true });
const lastCall = (method, pattern) =>
  calls.filter((call) => call.method === method && pattern.test(call.path)).at(-1);
const screenshot = async (name) => {
  if (screenshotDirectory)
    await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
};
const workDirectoryLabel = '作業ディレクトリ（計算ノードからも同じパスで見える絶対パス）';

console.log('Site computers: a launcher shows its token once with launcher.toml, and gets a new one');
await page.goto(`${base}/admin/launchers`);
await page.getByText('ランチャーはまだ登録されていません。').waitFor();
await page.getByRole('button', { name: 'ランチャーを登録', exact: true }).click();
await fill('名前', 'main');
await dialog().getByRole('button', { name: '作成', exact: true }).click();
const tokenField = dialog().getByLabel('ランチャーのtoken', { exact: true });
await tokenField.waitFor();
const token = await tokenField.inputValue();
assert.match(token, /^mmt_browser_launcher_/);
const config = await dialog().getByTestId('launcher-config-example').textContent();
assert.ok(config.includes(`api_url = "${base}"`), config);
assert.ok(config.includes('token_file = "/run/secrets/mado-tracking-launcher/launcher.token"'));
assert.ok(!config.includes(token), 'launcher.toml names the token file instead of the token');
await screenshot('site-computers-launcher-token');
await dialog().getByRole('button', { name: '閉じる', exact: true }).last().click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
const mainLauncher = api.state.launchers[0];
await page.getByRole('button', { name: 'tokenを作り直す', exact: true }).click();
await dialog().getByRole('button', { name: 'tokenを作り直す', exact: true }).click();
// The confirmation's title also starts with "ランチャーのtoken", so the field is matched exactly.
const rotatedToken = page.getByLabel('ランチャーのtoken', { exact: true });
await rotatedToken.waitFor();
assert.equal(await rotatedToken.inputValue(), 'mmt_browser_rotated');
assert.equal(lastCall('POST', /\/token$/).path, `/launchers/${mainLauncher.id}/token`);
await dialog().getByRole('button', { name: '閉じる', exact: true }).last().click();

console.log('Site computers: a global administrator adds a global Slurm site from its template');
await page.goto(`${projectBase}/compute`);
await page.getByRole('button', { name: '計算機を追加', exact: true }).click();
await select('Executor', 'site');
assert.equal(await dialog().getByLabel('使える範囲').inputValue(), 'global');
await select('job shellの雛形', 'slurm');
assert.equal(await jobShellEditor(dialog()).inputValue(), exampleJobShell('slurm'));
assert.equal(
  await dialog().getByLabel('取消コマンド（任意。MMT_SCHEDULER_JOB_IDを読む）').inputValue(),
  'scancel "$MMT_SCHEDULER_JOB_ID"',
);
assert.equal(await dialog().getByLabel('job shellがarrayを1回の投入で扱える').isChecked(), true);
await fill('名前', 'Slurm cluster');
await select('ランチャー', mainLauncher.id);
await fill('接続先のhost', 'slurm-login.example.invalid');
await fill('経由するホスト（1行に1つ、[user@]host[:port]）', 'gateway.example.invalid');
await fill('known_hosts（接続先と経由するホストの行）', 'slurm-login.example.invalid ssh-ed25519 AAAAtest');
await select('ログインするアカウント', 'shared');
await fill('共用アカウント名', 'mmt-launcher');
await fill(workDirectoryLabel, '/shared/mmt');
await fill('変数（NAME=VALUEを1行に1つ。job shellにはMMT_VAR_NAMEで渡ります）', 'ACCOUNT=lab-a');
await screenshot('site-computers-target-dialog');
await dialog().getByRole('button', { name: '保存', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
const createdSlurm = lastCall('POST', /^\/targets$/).body;
assert.equal(createdSlurm.personal, false);
assert.ok(!('projectIds' in createdSlurm));
assert.equal(createdSlurm.jobShell, exampleJobShell('slurm'));
assert.deepEqual(createdSlurm.runtimeKinds, ['apptainer']);
assert.deepEqual(createdSlurm.site.connection, {
  host: 'slurm-login.example.invalid',
  port: 22,
  jumpHosts: ['gateway.example.invalid'],
  knownHosts: 'slurm-login.example.invalid ssh-ed25519 AAAAtest\n',
});
assert.equal(createdSlurm.site.sharedAccount, 'mmt-launcher');
assert.deepEqual(createdSlurm.site.variables, { ACCOUNT: 'lab-a' });
const slurm = api.state.targets.find((target) => target.name === 'Slurm cluster');

console.log('Site computers: the new site shows its job shell, shared key and login checks');
const details = page.getByTestId('site-computer-details');
await details.getByRole('heading', { name: 'Slurm cluster' }).waitFor();
await details.getByText('版1を表示しています').waitFor();
await details.getByText('自分の設定はありません', { exact: false }).waitFor();
// The key requested with the site appears once the launcher has made it (the next poll).
await details.getByText('mmt-launcher:main:', { exact: false }).waitFor({ timeout: 15000 });
await details.getByText('共用アカウント（mmt-launcher）の~/.ssh/authorized_keys', { exact: false }).waitFor();
assert.equal(await details.getByRole('region', { name: '利用者の設定' }).count(), 0);
await details.getByRole('button', { name: '接続を確認', exact: true }).click();
await details.getByText('Permission denied (publickey).').waitFor();
assert.deepEqual(lastCall('POST', /connection-checks$/).body, { personal: false });
await screenshot('site-computers-shared-site');
await details.getByRole('button', { name: '鍵を作り直す', exact: true }).click();
await dialog().getByRole('button', { name: '鍵を作り直す', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
assert.deepEqual(lastCall('POST', /keys\/rotate$/).body, { personal: false });

console.log('Site computers: job shell versions, saved only when the content changes');
await details.getByRole('button', { name: 'job shellを編集', exact: true }).click();
assert.equal(await jobShellEditor(details).inputValue(), exampleJobShell('slurm'));
await details.getByRole('button', { name: '新しい版として保存', exact: true }).click();
await details.getByText('内容が今の版と同じなので', { exact: false }).waitFor();
await details.getByRole('button', { name: 'job shellを編集', exact: true }).click();
await jobShellEditor(details).fill('#!/bin/sh\necho v2\n');
await details.getByRole('button', { name: '新しい版として保存', exact: true }).click();
await details.getByText('版2を保存しました', { exact: false }).waitFor();
await details.getByText('版2を表示しています').waitFor();
await details.getByRole('row').filter({ hasText: 'v1' }).getByRole('button', { name: '表示' }).click();
await details.getByText('版1を表示しています').waitFor();
await details.locator('.job-shell-content').getByText('sbatch', { exact: false }).first().waitFor();
await details.getByRole('button', { name: '今の版を表示', exact: true }).click();
await details.getByText('echo v2').waitFor();

console.log('Site computers: a researcher adds their own manual PC and shares it with the Project');
api.state.user.isAdmin = false;
await page.goto(`${projectBase}/compute`);
await page.getByRole('button', { name: '計算機を追加', exact: true }).click();
await dialog().getByText('自分の計算機として追加します', { exact: false }).waitFor();
assert.equal(await dialog().getByLabel('Executor').count(), 0);
assert.equal(await dialog().getByLabel('使える範囲').count(), 0);
await select('job shellの雛形', 'direct-docker');
await select('投入方式', 'manual');
assert.equal(await dialog().getByLabel('ランチャー').count(), 0);
await fill('名前', 'Alice PC');
await select('共有するProject', [api.state.project.id]);
await fill(workDirectoryLabel, '/home/ui/mmt');
await dialog().getByRole('button', { name: '保存', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
const createdPc = lastCall('POST', /^\/targets$/).body;
assert.equal(createdPc.executor, 'site');
assert.equal(createdPc.personal, true);
assert.deepEqual(createdPc.projectIds, [api.state.project.id]);
assert.equal(createdPc.site.connection, null);
assert.equal(createdPc.site.gpuAssignment, 'lease');
assert.equal(createdPc.jobShell, exampleJobShell('direct-docker'));
// The choices were the adder's own Projects, as the API lists them.
assert.ok(lastCall('GET', /^\/targets\/shareable-projects$/));
const pc = api.state.targets.find((target) => target.name === 'Alice PC');

console.log('Site computers: its owner waits with --watch, takes everyone\'s Jobs with --all');
const pcDetails = page.getByTestId('site-computer-details');
await pcDetails.getByRole('heading', { name: 'Alice PC' }).waitFor();
await pcDetails.getByText(`mado-tracking submit --site ${pc.id} --watch`, { exact: true }).waitFor();
await pcDetails.getByText(`mado-tracking submit --site ${pc.id} --watch --all`, { exact: true }).waitFor();
assert.equal(await pcDetails.getByLabel('あなたのアカウント名').count(), 0);
await pcDetails
  .getByLabel('変数（任意。NAME=VALUEを1行に1つ。計算機の変数より優先します）')
  .fill('GROUP=lab');
await pcDetails.getByRole('button', { name: '自分の設定を保存', exact: true }).click();
await pcDetails.getByText('自分の設定を保存しました。').waitFor();
assert.deepEqual(lastCall('PUT', /personal-settings\/me$/).body, {
  workDirectory: null,
  variables: { GROUP: 'lab' },
});
const personalList = pcDetails.getByRole('region', { name: '利用者の設定' });
await personalList.getByRole('button', { name: '再読み込み' }).click();
await personalList.getByText('GROUP=lab').waitFor();
await screenshot('site-computers-owned-pc');

console.log('Site computers: the owner stops sharing; the edit PUTs the Projects after the PATCH');
await page.getByTestId(`target-edit-${pc.id}`).click();
assert.equal(await dialog().getByLabel('Executor').count(), 0);
await select('共有するProject', []);
await dialog().getByRole('button', { name: '保存', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
assert.deepEqual(lastCall('PUT', /\/projects$/).body, { projectIds: [] });
assert.equal(lastCall('PATCH', /^\/targets\/[^/]+$/).path, `/targets/${pc.id}`);
await page.getByRole('row').filter({ hasText: 'Alice PC' }).getByText('共有なし（本人だけ）').waitFor();

console.log("Site computers: a global administrator editing someone else's PC chooses among its owner's Projects");
api.state.user.isAdmin = true;
Object.assign(pc, { ownerUserId: id(), ownerName: 'Bob', projectIds: [api.state.project.id] });
ownerProjects = [{ id: id(), name: 'Owner Lab' }];
await page.goto(`${projectBase}/compute`);
await page.getByRole('row').filter({ hasText: 'Alice PC' }).getByText('Bobさんの計算機').waitFor();
await page.getByTestId(`target-edit-${pc.id}`).click();
const ownerSharing = dialog().getByLabel('共有するProject');
await ownerSharing.waitFor();
// Bob may no longer share it with the Project it is shared with, which stays to be taken off.
assert.deepEqual(await ownerSharing.locator('option').allTextContents(), [
  'Owner Lab',
  `${api.state.project.name}（所有者がEditor以上ではありません）`,
]);
await dialog().getByText('選べるのは、所有者がEditor以上のProjectです。', { exact: false }).waitFor();
assert.equal(lastCall('GET', /shareable-projects$/).path, `/targets/${pc.id}/shareable-projects`);
await select('共有するProject', [ownerProjects[0].id]);
await dialog().getByRole('button', { name: '保存', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
assert.deepEqual(lastCall('PUT', /\/projects$/).body, { projectIds: [ownerProjects[0].id] });

console.log("Site computers: when the owner's Projects cannot be read, an edit leaves the sharing alone");
const sharingPuts = () =>
  calls.filter((call) => call.method === 'PUT' && /\/projects$/.test(call.path)).length;
const sharingPutsBefore = sharingPuts();
ownerProjects = null;
await page.getByTestId(`target-edit-${pc.id}`).click();
await dialog().getByRole('alert').waitFor();
assert.equal(await dialog().getByLabel('共有するProject').count(), 0);
await dialog().getByRole('button', { name: '保存', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
assert.equal(sharingPuts(), sharingPutsBefore);
// The researcher again, owning the PC.
api.state.user.isAdmin = false;
ownerProjects = ownProjects;
Object.assign(pc, { ownerUserId: api.state.user.id, ownerName: api.state.user.displayName });
await page.goto(`${projectBase}/compute`);

console.log('Site computers: on a site of personal accounts, a researcher saves theirs and gets a key');
// As a researcher sees a global site: its account mode, not its settings.
const personalSite = { ...slurm, id: id(), name: 'ABCI', site: null, siteAccountMode: 'personal' };
api.state.targets.push(personalSite);
await page.getByRole('button', { name: '再読み込み', exact: true }).first().click();
await page.getByTestId(`target-details-${personalSite.id}`).click();
const personalDetails = page.getByTestId('site-computer-details');
await personalDetails
  .getByText('アカウント名を保存するまで、この計算機でJobを作れません', { exact: false })
  .waitFor();
await personalDetails.getByText('job shellがまだありません', { exact: false }).waitFor();
assert.equal(await personalDetails.getByRole('button', { name: 'job shellを編集' }).count(), 0);
assert.equal(await page.getByTestId(`target-edit-${personalSite.id}`).count(), 0);
const accountName = personalDetails.getByLabel('あなたのアカウント名');
assert.equal(await accountName.getAttribute('required'), '');
await accountName.fill('alice');
await personalDetails.getByRole('button', { name: '自分の設定を保存', exact: true }).click();
await personalDetails.getByText('あなた用の鍵').waitFor();
await personalDetails
  .getByText('あなたのアカウント（alice）の~/.ssh/authorized_keys', { exact: false })
  .waitFor({ timeout: 15000 });
assert.deepEqual(lastCall('PUT', /personal-settings\/me$/).body, {
  accountName: 'alice',
  workDirectory: null,
  variables: {},
});
await screenshot('site-computers-personal-account');

console.log('Site computers: a site Job shows the job shell version it was submitted with');
const shellOfJob = site.jobShells.get(slurm.id).at(-1);
const siteJob = {
  id: id(),
  projectId: api.state.project.id,
  runId: api.state.runs[0].id,
  targetId: slurm.id,
  status: 'claimed',
  gpuIds: [],
  workerId: null,
  leaseId: null,
  cancelRequested: false,
  attempt: 1,
  maxAttempts: 1,
  createdAt: now,
  startedAt: null,
  endedAt: null,
  heartbeatAt: null,
  exitCode: null,
  error: null,
  heartbeatStale: false,
  phase: 'submitted',
  gpuCount: 1,
  walltimeSeconds: 3600,
  schedulerJobId: '12345',
  submittedAt: now,
  runnerHost: null,
  arrayGroupId: null,
  arrayIndex: null,
  arraySize: null,
  endReason: null,
  parentJobId: null,
  chainDepth: 0,
  hookId: null,
  allowChildJobs: false,
  retryOnFailure: false,
  retryOnTimeout: false,
  datasetPartitionVersionId: null,
  siteJobShellId: shellOfJob.id,
};
api.state.jobs.push(siteJob);
await page.goto(`${projectBase}/jobs?job=${siteJob.id}`);
await page.locator('.job-detail').getByText('job shellの版').waitFor();
await page.locator('.job-detail').getByText('v1', { exact: true }).waitFor();
// Screens that choose where a Job runs read only the targets usable in the Project.
assert.ok(
  calls.some(
    (call) =>
      call.method === 'GET' && call.path === '/targets' && call.search === `?projectId=${api.state.project.id}`,
  ),
);

console.log('Site computers: a revoked launcher stays on its site, marked, until another is chosen');
api.state.user.isAdmin = true;
await page.goto(`${base}/admin/launchers`);
await page.getByRole('button', { name: '失効させる', exact: true }).click();
await dialog().getByRole('button', { name: '失効させる', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
await page.getByRole('row').filter({ hasText: 'main' }).getByText('失効', { exact: true }).waitFor();
assert.equal(await page.getByRole('button', { name: 'tokenを作り直す', exact: true }).count(), 0);
await page.goto(`${projectBase}/compute`);
await page.getByTestId(`target-edit-${slurm.id}`).click();
const launcherSelect = dialog().getByLabel('ランチャー');
assert.equal(await launcherSelect.inputValue(), mainLauncher.id);
assert.equal(await launcherSelect.locator('option:checked').textContent(), 'main（失効）');
await dialog().getByText('ランチャーはまだ登録されていません', { exact: false }).waitFor();
await dialog().getByRole('button', { name: 'キャンセル', exact: true }).click();

console.log('Site computers: at phone width the details stay within the screen');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${projectBase}/compute`);
await page.getByTestId(`target-details-${slurm.id}`).click();
await page.getByTestId('site-computer-details').waitFor();
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
await screenshot('site-computers-phone');

assert.deepEqual(pageErrors, []);
await browser.close();
console.log('Browser site computers passed');
