// Browser check for 全体設定 → ユーザー (/settings/users) and アカウント (/settings/account): create a
// local user and see its initial password once, disable a user after the confirmation, reset a
// password, keep SSO roles read-only, and send non-administrators from /settings/users to their
// account. The users API is mocked here until it is integrated.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const webUrl = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const outputDirectory =
  process.env.MMT_VERIFY_OUTPUT ?? 'artifacts/verification/2026-10-08/admin-users-web';
const { chromium } = await import(pathToFileURL(modulePath).href);
await mkdir(outputDirectory, { recursive: true });

const RESET_PASSWORD = 'reset-temporary-Passw0rd';
const api = createBrowserApi();
api.state.loggedIn = true;
const signedInUser = api.state.user;
const now = '2026-10-08T00:00:00Z';
const adminUser = (user) => ({
  username: null,
  status: 'active',
  kind: 'human',
  lastLoginAt: now,
  createdAt: now,
  ...user,
});
const users = {
  items: [
    adminUser({ ...signedInUser }),
    adminUser({
      id: '00000000-0000-4000-8000-000000000901',
      email: 'sso.admin@example.invalid',
      displayName: 'SSO管理者',
      isAdmin: true,
      authSources: ['oidc'],
    }),
    adminUser({
      id: '00000000-0000-4000-8000-000000000902',
      email: 'leaver@example.invalid',
      displayName: '退職予定者',
      username: 'leaver',
      isAdmin: false,
      authSources: ['local'],
    }),
  ],
  requests: [],
};
const account = { groups: [], groupsSyncedAt: null };

async function routeUsers(route) {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace(/^\/api/, '');
  const method = request.method();
  const reply = (payload, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  const body = request.postData() ? request.postDataJSON() : {};
  if (path === '/account')
    return reply({
      user: adminUser({ ...signedInUser }),
      groups: account.groups,
      groupsSyncedAt: account.groupsSyncedAt,
      sessionAuthMethod: signedInUser.authSources.includes('oidc') ? 'oidc' : 'local',
    });
  if (!path.startsWith('/admin/users')) return api.route(route);
  if (!signedInUser.isAdmin)
    return reply({ error: '管理者権限が必要です', code: 'admin_required' }, 403);
  users.requests.push({ method, path, body });
  if (path === '/admin/users' && method === 'GET') {
    const query = new URL(request.url()).searchParams.get('query')?.toLowerCase();
    return reply({
      items: users.items.filter(
        (user) => !query || `${user.displayName} ${user.email}`.toLowerCase().includes(query),
      ),
    });
  }
  if (path === '/admin/users' && method === 'POST') {
    const { password, ...profile } = body;
    const created = adminUser({
      id: `00000000-0000-4000-8000-00000000099${users.items.length}`,
      email: '',
      ...profile,
      authSources: ['local'],
      lastLoginAt: null,
    });
    users.items.push(created);
    return reply(created, 201);
  }
  const userId = path.split('/')[3];
  const user = users.items.find((item) => item.id === userId);
  if (!user) return reply({ error: 'Userが見つかりません', code: 'not_found' }, 404);
  if (path.endsWith('/reset-password')) return reply({ temporaryPassword: RESET_PASSWORD });
  if (body.isAdmin !== undefined && user.authSources.includes('oidc'))
    return reply({ error: 'SSO', code: 'admin_role_managed_by_sso' }, 422);
  Object.assign(user, body);
  return reply(user);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
});
const pageErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: webUrl });
  await context.route((url) => url.pathname.startsWith('/api/'), routeUsers);
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // The user menu opens 全体設定 on the account; the sidebar's 全体管理 group switches to Users.
  await page.goto(`${webUrl}/projects/${api.state.project.id}/experiments`);
  await page.getByRole('button', { name: 'ユーザーメニュー', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: '全体管理', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: '全体設定', exact: true }).click();
  await page.waitForURL(/\/settings\/account$/);
  await page
    .getByRole('group', { name: '全体管理', exact: true })
    .getByRole('link', { name: 'ユーザー', exact: true })
    .click();
  await page.waitForURL(/\/settings\/users$/);
  await page.getByRole('heading', { name: 'ユーザー', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('link', { name: 'ユーザー', exact: true }).getAttribute('aria-current'),
    'page',
  );
  await page.getByRole('cell', { name: '退職予定者' }).waitFor();

  // SSO users' administrator role is read-only: no button, only the source of truth.
  const ssoRow = page.getByRole('row', { name: /SSO管理者/ });
  await ssoRow.getByText('Authentikのgroupが正本').waitFor();
  assert.equal(await ssoRow.getByRole('button', { name: /管理者/ }).count(), 0);
  assert.equal(await ssoRow.getByRole('button', { name: 'パスワード再設定' }).count(), 0);
  await page.screenshot({ path: `${outputDirectory}/01-admin-users.png`, fullPage: true });

  // Create a local user; the initial password is shown once after saving.
  await page.getByRole('button', { name: 'ローカルユーザーを作成' }).click();
  const dialog = page.getByRole('dialog', { name: 'ローカルユーザーを作成' });
  await dialog.getByLabel('ユーザー名').fill('new.member');
  await dialog.getByLabel('表示名').fill('新しいメンバー');
  await dialog.getByLabel('初回パスワード').fill('short');
  await dialog.getByRole('button', { name: '作成' }).click();
  await dialog.getByText('初回パスワードは12 byte以上にしてください').waitFor();
  await dialog.getByRole('button', { name: '生成' }).click();
  const initialPassword = await dialog.getByLabel('初回パスワード').inputValue();
  assert.match(initialPassword, /^[A-Za-z0-9_-]{24}$/);
  await dialog.getByRole('button', { name: '作成' }).click();
  await dialog.getByTestId('temporary-password').waitFor();
  assert.equal(await dialog.getByTestId('temporary-password').textContent(), initialPassword);
  const created = users.requests.find((request) => request.method === 'POST').body;
  assert.deepEqual(created, {
    username: 'new.member',
    displayName: '新しいメンバー',
    password: initialPassword,
    isAdmin: false,
  });
  await dialog.getByRole('button', { name: 'コピー' }).click();
  await dialog.getByRole('button', { name: 'コピーしました' }).waitFor();
  await page.screenshot({ path: `${outputDirectory}/02-initial-password-once.png` });
  await dialog.getByRole('button', { name: '閉じる' }).last().click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('cell', { name: /新しいメンバー/ }).waitFor();
  assert.ok(!(await page.content()).includes(initialPassword), 'the password is not shown again');

  // Disabling asks first and says the sessions end.
  const leaverRow = page.getByRole('row', { name: /退職予定者/ });
  await leaverRow.getByRole('button', { name: '無効化' }).click();
  const confirm = page.getByRole('dialog', { name: 'ユーザーを無効化' });
  await confirm.getByText(/sessionは直ちに終了/).waitFor();
  await page.screenshot({ path: `${outputDirectory}/03-disable-confirm.png` });
  await confirm.getByRole('button', { name: '無効化' }).click();
  await confirm.waitFor({ state: 'detached' });
  await leaverRow.getByRole('button', { name: '有効化' }).waitFor();
  assert.ok(
    users.requests.some(
      (request) => request.method === 'PATCH' && request.body.status === 'disabled',
    ),
  );

  // A password reset shows the temporary password once.
  await leaverRow.getByRole('button', { name: 'パスワード再設定' }).click();
  await page
    .getByRole('dialog', { name: 'パスワードを再設定' })
    .getByRole('button', { name: 'パスワード再設定' })
    .click();
  await page.getByTestId('temporary-password').filter({ hasText: RESET_PASSWORD }).waitFor();
  await page.screenshot({ path: `${outputDirectory}/04-reset-password-once.png` });
  await page
    .getByRole('dialog', { name: 'パスワードを再設定' })
    .getByRole('button', { name: '閉じる' })
    .last()
    .click();
  assert.ok(!(await page.content()).includes(RESET_PASSWORD));

  // The avatar opens the user menu; the account shows the profile, password form and tokens.
  await page.getByRole('button', { name: 'ユーザーメニュー' }).click();
  await page.getByRole('menuitem', { name: 'パスワードの変更', exact: true }).waitFor();
  await page.screenshot({ path: `${outputDirectory}/05-user-menu.png` });
  await page.getByRole('menuitem', { name: 'アカウント', exact: true }).click();
  await page.waitForURL(/\/settings\/account$/);
  await page.getByRole('heading', { name: 'プロフィール' }).waitFor();
  await page.getByLabel('現在のパスワード').waitFor();
  await page.getByRole('heading', { name: '自分のAPI token' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '所属group' }).count(), 0);
  await page.screenshot({ path: `${outputDirectory}/06-account-local.png`, fullPage: true });

  // An SSO user sees their groups read-only and no password form. The URL from before 全体設定
  // still opens the account.
  signedInUser.authSources = ['oidc'];
  account.groups = ['mmt-users', 'team-a'];
  account.groupsSyncedAt = now;
  await page.goto(`${webUrl}/account`);
  await page.waitForURL(/\/settings\/account$/);
  await page.getByRole('heading', { name: '所属group' }).waitFor();
  await page.getByText('team-a', { exact: true }).waitFor();
  await page.getByText(/Authentikのgroupが正本です/).waitFor();
  assert.equal(await page.getByLabel('現在のパスワード').count(), 0);
  await page.screenshot({ path: `${outputDirectory}/07-account-sso.png`, fullPage: true });

  // Someone who is not a global administrator gets 全体設定 but no 全体管理 links, and the users
  // section, by its old or new URL, sends them to their account.
  signedInUser.isAdmin = false;
  for (const usersPath of ['/admin/users', '/settings/users']) {
    await page.goto(`${webUrl}${usersPath}`);
    await page.waitForURL(/\/settings\/account$/);
  }
  await page.getByRole('group', { name: '全体設定', exact: true }).waitFor();
  assert.equal(await page.getByRole('group', { name: '全体管理', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'ユーザー', exact: true }).count(), 0);
  await page.screenshot({ path: `${outputDirectory}/08-non-admin-redirected.png` });

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, outputDirectory }));
} finally {
  await browser.close();
}
