// Browser check for /admin storage: create a backend, run its connection test, change the default,
// and pick backends in the Project forms. The storage API is mocked here until it is integrated.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const webUrl = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const outputDirectory = process.env.MMT_VERIFY_OUTPUT ?? 'artifacts/verification/2026-10-08/storage-web';
const { chromium } = await import(pathToFileURL(modulePath).href);
await mkdir(outputDirectory, { recursive: true });

const SECRET_VALUE = 'browser-test-secret-value';
const MIB = 1024 * 1024;
const api = createBrowserApi();
api.state.loggedIn = true;
const storage = {
  defaultBackend: 'filesystem',
  backends: [
    {
      name: 'filesystem',
      kind: 'filesystem',
      source: 'environment',
      rootPath: '/var/lib/mmt/artifacts',
      signatureVersion: 'v4',
      tlsVerify: true,
      caBundleConfigured: false,
      checksumMode: 'when_required',
      multipartPartSizeBytes: 16 * MIB,
      secretConfigured: false,
      enabled: true,
    },
  ],
  requests: [],
};

function toBackend(body) {
  const { secretAccessKey, caBundle, ...settings } = body;
  return {
    signatureVersion: 'v4',
    tlsVerify: true,
    checksumMode: 'when_required',
    multipartPartSizeBytes: 16 * MIB,
    enabled: true,
    ...settings,
    source: 'database',
    caBundleConfigured: Boolean(caBundle),
    secretConfigured: Boolean(secretAccessKey),
  };
}

async function routeStorage(route) {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace(/^\/api/, '');
  const method = request.method();
  const reply = (payload, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  const body = request.postData() ? request.postDataJSON() : {};
  if (path === '/storage/backends')
    return reply({
      items: storage.backends.filter((backend) => backend.enabled).map((backend) => backend.name),
      defaultBackend: storage.defaultBackend,
    });
  if (path === '/admin/storage-settings') {
    if (method === 'PUT') storage.defaultBackend = body.defaultBackend;
    return reply({ defaultBackend: storage.defaultBackend });
  }
  if (path === '/admin/storage-backends') {
    if (method === 'GET') return reply({ items: storage.backends });
    storage.requests.push(body);
    if (body.signatureVersion === 'v2')
      return reply(
        { error: 'Signature Version 2 is not supported yet', code: 'storage_signature_unsupported' },
        422,
      );
    const backend = toBackend(body);
    storage.backends.push(backend);
    return reply(backend);
  }
  const testMatch = path.match(/^\/admin\/storage-backends\/([^/]+)\/test$/);
  if (testMatch)
    return reply({
      steps: [
        { name: 'put', ok: true },
        { name: 'get', ok: true },
        { name: 'range', ok: true },
        { name: 'delete', ok: false, error: 'AccessDenied: s3:DeleteObject is not allowed' },
      ],
    });
  return api.route(route);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
});
const pageErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route((url) => url.pathname.startsWith('/api/'), routeStorage);
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${webUrl}/projects/${api.state.project.id}/experiments`);
  await page.getByRole('link', { name: '全体管理' }).click();
  await page.waitForURL(/\/admin$/);
  await page.getByRole('tab', { name: 'ストレージ' }).click();
  await page.getByRole('cell', { name: '/var/lib/mmt/artifacts' }).waitFor();
  await page.screenshot({ path: `${outputDirectory}/01-admin-storage.png`, fullPage: true });

  // Create an S3 backend: v2 is refused by the API for now, then v4 is saved.
  await page.getByRole('button', { name: '保存先を追加' }).click();
  const dialog = page.getByRole('dialog', { name: '保存先を追加' });
  await dialog.getByLabel('名前').fill('minio-main');
  await dialog.getByLabel('Endpoint URL（AWSなら空欄）').fill('https://minio.example.internal:9000');
  await dialog.getByLabel('Bucket').fill('mmt-artifacts');
  await dialog.getByLabel('Prefix（任意）').fill('/team-a/');
  await dialog.getByLabel('path-styleでアクセスする').check();
  await dialog.getByLabel('Access key ID（任意）').fill('AKIAEXAMPLE');
  await dialog.getByLabel('Secret access key').fill(SECRET_VALUE);
  assert.equal(await dialog.getByLabel('Secret access key').getAttribute('type'), 'password');
  await dialog.getByLabel('署名').selectOption('v2');
  await dialog.getByRole('button', { name: '作成' }).click();
  await dialog.getByText('Signature Version 2に対応していません').waitFor();
  await page.screenshot({ path: `${outputDirectory}/02-signature-v2-unsupported.png` });
  await dialog.getByLabel('署名').selectOption('v4');
  await dialog.getByRole('button', { name: '作成' }).click();
  await dialog.waitFor({ state: 'detached' });
  const created = storage.requests.at(-1);
  assert.equal(created.prefix, 'team-a');
  assert.equal(created.signatureVersion, 'v4');
  assert.equal(created.rootPath, undefined, 'S3 backends do not send the filesystem root');
  assert.ok(!(await page.content()).includes(SECRET_VALUE), 'the secret is never rendered');

  // Editing shows the stored secret only as configured.
  const s3Row = page.getByRole('row', { name: /minio-main/ });
  await s3Row.getByRole('button', { name: '変更' }).click();
  const editDialog = page.getByRole('dialog', { name: '保存先を変更' });
  assert.equal(await editDialog.getByLabel('Secret access key').inputValue(), '');
  assert.match(
    (await editDialog.getByLabel('Secret access key').getAttribute('placeholder')) ?? '',
    /設定済み/,
  );
  await page.screenshot({ path: `${outputDirectory}/03-edit-secret-configured.png` });
  await editDialog.getByRole('button', { name: 'キャンセル' }).click();

  await s3Row.getByRole('button', { name: '接続テスト' }).click();
  await page.getByText('AccessDenied: s3:DeleteObject is not allowed').waitFor();
  await page.screenshot({ path: `${outputDirectory}/04-connection-test.png`, fullPage: true });

  await s3Row.getByRole('button', { name: '既定にする' }).click();
  const confirm = page.getByRole('dialog', { name: '既定の保存先を変更' });
  await confirm.getByText('既存のArtifactは移動しません').waitFor();
  await page.screenshot({ path: `${outputDirectory}/05-default-confirm.png` });
  await confirm.getByRole('button', { name: '既定にする' }).click();
  await confirm.waitFor({ state: 'detached' });
  await s3Row.getByText('既定の保存先').waitFor();
  assert.equal(storage.defaultBackend, 'minio-main');
  await page.screenshot({ path: `${outputDirectory}/06-default-changed.png`, fullPage: true });

  // A new Project starts on the new default; the settings list shows names with kinds.
  await page.goto(`${webUrl}/projects/${api.state.project.id}/settings`);
  await page.getByRole('radio', { name: /filesystem/ }).first().waitFor();
  assert.ok(await page.getByRole('radio', { name: /^filesystem/ }).isChecked());
  await page.getByRole('button', { name: 'プロジェクトを作成' }).first().click();
  const projectDialog = page.getByRole('dialog', { name: 'プロジェクトを作成' });
  assert.ok(await projectDialog.getByRole('radio', { name: /minio-main/ }).isChecked());
  await page.screenshot({ path: `${outputDirectory}/07-new-project-default.png` });
  await projectDialog.getByRole('button', { name: 'キャンセル' }).click();

  // Someone who is not a global administrator gets no link, and /admin sends them back.
  api.state.user.isAdmin = false;
  await page.goto(`${webUrl}/admin`);
  await page.waitForURL(/\/projects\/[^/]+\/experiments$/);
  assert.equal(await page.getByRole('link', { name: '全体管理' }).count(), 0);
  await page.screenshot({ path: `${outputDirectory}/08-non-admin.png` });

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, outputDirectory }));
} finally {
  await browser.close();
}
