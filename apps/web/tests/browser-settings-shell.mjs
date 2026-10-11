// Browser check of 全体設定 (/settings/<section>) against the isolated mock API (tests/browserApi.mjs):
// the 全体設定 group (アカウント, コンピュータ) for everyone and 全体管理 only for global
// administrators, in the Project's sidebar, in 全体設定's own, in the rail and in the drawer; the
// user menu (アカウント, パスワードの変更 for local accounts, 全体設定); each page's heading under its
// group; and the URLs from before 全体設定 (/account, /admin/<section>) moving to the new ones.
// Start Vite on MMT_WEB_URL first; MMT_SCREENSHOT_DIR, when set, receives the screenshots.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
// The full sidebar from --bp-lg, the rail between --bp-md and --bp-lg, the drawer below --bp-md.
const WIDE = { width: 1440, height: 1250 };
const RAIL = { width: 1100, height: 800 };
const NARROW = { width: 390, height: 844 };

const api = createBrowserApi();
api.state.loggedIn = true;
const user = api.state.user;
const projectPath = `/projects/${api.state.project.id}/experiments`;

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
});
const pageErrors = [];

async function openPage(viewport) {
  const context = await browser.newContext({ viewport });
  await context.route((url) => url.pathname.startsWith('/api/'), api.route);
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return page;
}

const screenshot = async (page, name) => {
  if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/${name}.png` });
};
const groupLabels = (scope) => scope.locator('.navigation-group-label').allInnerTexts();
const groupLinks = (scope, name) =>
  scope.getByRole('group', { name, exact: true }).getByRole('link').allInnerTexts();
// Navigation keeps the old screen until a lazily loaded page arrives, so wait for the mark to move.
const waitForCurrentLink = (scope, name) =>
  scope.locator('a[aria-current="page"]').filter({ hasText: name }).waitFor();
const waitForHeading = async (page, { eyebrow, title }) => {
  await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
  assert.equal(await page.locator('.page-header .eyebrow').innerText(), eyebrow);
};
const openUserMenu = async (page) => {
  await page.getByRole('button', { name: 'ユーザーメニュー', exact: true }).click();
  await page.getByRole('menu', { name: 'ユーザーメニュー', exact: true }).waitFor();
  return page.getByRole('menuitem').allInnerTexts();
};
/** Opens a URL and waits for the 全体設定 screen it ends up on. */
const settle = async (page, path, expectedPath) => {
  await page.goto(`${base}${path}`);
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
  await page.locator('.navigation-sidebar a[aria-current="page"]').waitFor();
};

try {
  console.log('Settings: a user who is not a global administrator gets 全体設定 only');
  user.isAdmin = false;
  user.authSources = ['local'];
  let page = await openPage(WIDE);
  await page.goto(`${base}${projectPath}`);
  const sidebar = page.locator('.navigation-sidebar');
  await sidebar.getByRole('link', { name: 'Experiments', exact: true }).waitFor();
  const projectGroups = await groupLabels(sidebar);
  assert.equal(projectGroups.at(-1), '全体設定');
  assert.ok(!projectGroups.includes('全体管理'));
  assert.deepEqual(await groupLinks(sidebar, '全体設定'), ['アカウント', 'コンピュータ']);
  assert.deepEqual(await openUserMenu(page), ['アカウント', 'パスワードの変更', '全体設定']);
  await screenshot(page, '01-user-project-sidebar-menu');
  await page.getByRole('menuitem', { name: '全体設定', exact: true }).click();
  await page.waitForURL(`${base}/settings/account`);
  await waitForHeading(page, { eyebrow: '全体設定', title: 'アカウント' });
  assert.deepEqual(await groupLabels(sidebar), ['全体設定']);
  await screenshot(page, '02-user-settings-account');

  await sidebar.getByRole('link', { name: 'コンピュータ', exact: true }).click();
  await page.waitForURL(`${base}/settings/computers`);
  await waitForCurrentLink(sidebar, 'コンピュータ');

  await openUserMenu(page);
  await page.getByRole('menuitem', { name: 'パスワードの変更', exact: true }).click();
  await page.waitForURL(`${base}/settings/account/password`);
  await waitForHeading(page, { eyebrow: '全体設定', title: 'パスワードの変更' });
  // The password change belongs to the account section, so アカウント stays marked.
  await waitForCurrentLink(sidebar, 'アカウント');
  await screenshot(page, '03-user-password-change');

  console.log('Settings: URLs from before 全体設定 move, and 全体管理 sends a user to the account');
  for (const [path, expectedPath] of [
    ['/settings', '/settings/account'],
    ['/account', '/settings/account'],
    ['/account/password', '/settings/account/password'],
    ['/admin', '/settings/account'],
    ['/admin/users', '/settings/account'],
    ['/settings/users', '/settings/account'],
    ['/settings/unknown', '/settings/account'],
  ])
    await settle(page, path, expectedPath);
  // The redirect replaces the old entry, so Back skips it.
  await settle(page, '/settings/computers', '/settings/computers');
  await settle(page, '/account', '/settings/account');
  await page.goBack();
  await page.waitForURL(`${base}/settings/computers`);
  await page.context().close();

  console.log('Settings: an SSO user has no password change');
  user.authSources = ['oidc'];
  page = await openPage(WIDE);
  await settle(page, '/settings/account/password', '/settings/account');
  assert.deepEqual(await openUserMenu(page), ['アカウント', '全体設定']);
  await page.context().close();

  console.log('Settings: a global administrator also gets 全体管理');
  user.isAdmin = true;
  user.authSources = ['local'];
  page = await openPage(WIDE);
  await page.goto(`${base}${projectPath}`);
  const adminSidebar = page.locator('.navigation-sidebar');
  await adminSidebar.getByRole('link', { name: 'Experiments', exact: true }).waitFor();
  assert.deepEqual((await groupLabels(adminSidebar)).slice(-2), ['全体設定', '全体管理']);
  assert.deepEqual(await groupLinks(adminSidebar, '全体管理'), [
    'プロジェクト',
    'ユーザー',
    'ストレージ',
    'ランチャー',
    '監査ログ',
  ]);
  assert.deepEqual(await openUserMenu(page), ['アカウント', 'パスワードの変更', '全体設定']);
  await screenshot(page, '04-admin-project-sidebar-menu');
  await page.keyboard.press('Escape');
  await settle(page, '/admin', '/settings/projects');
  await waitForHeading(page, { eyebrow: '全体管理', title: 'プロジェクト' });
  assert.deepEqual(await groupLabels(adminSidebar), ['全体設定', '全体管理']);
  await screenshot(page, '05-admin-settings-projects');
  await settle(page, '/admin/launchers?from=bookmark', '/settings/launchers?from=bookmark');
  await waitForHeading(page, { eyebrow: '全体管理', title: 'ランチャー' });
  await settle(page, '/admin/unknown', '/settings/projects');
  await settle(page, '/settings/unknown', '/settings/account');
  await page.context().close();

  console.log('Settings: the rail and the drawer show the same groups');
  page = await openPage(RAIL);
  await page.goto(`${base}/settings/account`);
  await page.locator('.navigation-sidebar[data-collapsed="true"]').waitFor();
  const railTitles = await page
    .locator('.navigation-sidebar a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('title')));
  assert.deepEqual(railTitles, [
    'アカウント',
    'コンピュータ',
    'プロジェクト',
    'ユーザー',
    'ストレージ',
    'ランチャー',
    '監査ログ',
  ]);
  await screenshot(page, '06-admin-rail');
  await page.context().close();

  user.isAdmin = false;
  page = await openPage(NARROW);
  await page.goto(`${base}${projectPath}`);
  await page.getByRole('button', { name: 'メニューを開く', exact: true }).click();
  const drawer = page.locator('dialog.navigation-drawer[open]');
  await drawer.getByRole('link', { name: 'Experiments', exact: true }).waitFor();
  const drawerGroups = await groupLabels(drawer);
  assert.equal(drawerGroups.at(-1), '全体設定');
  assert.ok(!drawerGroups.includes('全体管理'));
  await drawer.getByRole('link', { name: 'コンピュータ', exact: true }).click();
  await page.waitForURL(`${base}/settings/computers`);
  await page.getByRole('button', { name: 'メニューを開く', exact: true }).click();
  assert.deepEqual(await groupLabels(page.locator('dialog.navigation-drawer[open]')), ['全体設定']);
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  await screenshot(page, '07-user-drawer-settings');
  await page.context().close();

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, screenshotDirectory }));
} finally {
  await browser.close();
}
