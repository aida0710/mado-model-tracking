// MLflow 3 connection card on the Project settings page with a mocked API: the URIs point at this
// Project, the copy buttons put the exact values on the clipboard, the details stay folded until
// opened, the token dialog opens with the MLflow scopes selected, and a viewer gets no button.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const outputDirectory = process.env.MMT_SCREENSHOT_DIR;
if (outputDirectory) await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});

async function openSettings(role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const api = createBrowserApi();
  api.state.loggedIn = true;
  api.state.project.role = role;
  // The shared mock's member rows predate group bindings; the settings page needs `groups`.
  const membersPath = `/api/projects/${api.state.project.id}/members`;
  await context.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const request = route.request();
      if (new URL(request.url()).pathname === membersPath && request.method() === 'GET')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [{ user: api.state.user, role, directRole: role, groups: [] }],
          }),
        });
      return api.route(route);
    },
  );
  const page = await context.newPage();
  await page.goto(`${base}/projects/${api.state.project.id}/settings`);
  const card = page.locator('section.mlflow-connection');
  await card.getByRole('heading', { name: 'MLflow 3から接続' }).waitFor();
  return { context, page, card, api };
}

try {
  const { context, page, card, api } = await openSettings('admin');
  const trackingUri = `${base}/api/mlflow/projects/${api.state.project.id}`;
  await card.getByText(trackingUri, { exact: true }).first().waitFor();

  await card.locator('dd', { hasText: trackingUri }).first().getByRole('button').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), trackingUri);

  const environment = card.locator('.mlflow-connection-snippet').first();
  await environment.getByRole('button', { name: 'コピー' }).click();
  const copiedEnvironment = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copiedEnvironment, new RegExp(`export MLFLOW_REGISTRY_URI=${trackingUri}\n`));
  assert.match(copiedEnvironment, /read -r -s -p 'API token: ' MLFLOW_TRACKING_TOKEN/);

  const more = card.locator('details.mlflow-connection-more');
  assert.equal(await more.getByText('import mlflow').isVisible(), false);
  if (outputDirectory) await card.screenshot({ path: `${outputDirectory}/01-connection-card.png` });
  await more.locator('summary').click();
  await more.getByText('MLFLOW_TRACKING_USERNAME=mado').waitFor();
  await more.getByText(/Service Account/).waitFor();
  if (outputDirectory)
    await card.screenshot({ path: `${outputDirectory}/02-connection-card-details.png` });

  await card.getByRole('button', { name: 'このProject用のAPI tokenを発行' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const selected = await dialog
    .locator('select[multiple] option:checked, input[type=checkbox]:checked')
    .evaluateAll((elements) =>
      elements.map((element) => element.value || element.getAttribute('value')),
    );
  assert.deepEqual(selected.sort(), ['artifacts:write', 'read', 'registry:write', 'runs:write']);
  if (outputDirectory) await page.screenshot({ path: `${outputDirectory}/03-token-dialog.png` });

  await dialog.getByLabel('名前').fill('mlflow-sdk');
  await dialog.getByRole('button', { name: '保存' }).click();
  await dialog.getByText('API tokenは一度だけ表示されます', { exact: false }).waitFor();
  const created = api.state.tokens.at(-1);
  assert.deepEqual([...created.scopes].sort(), [
    'artifacts:write',
    'read',
    'registry:write',
    'runs:write',
  ]);
  assert.equal(created.projectId, api.state.project.id);
  await dialog.getByRole('button', { name: '閉じる' }).last().click();
  await context.close();

  const viewer = await openSettings('viewer');
  assert.equal(
    await viewer.card.getByRole('button', { name: 'このProject用のAPI tokenを発行' }).count(),
    0,
  );
  await viewer.context.close();
  console.log('mlflow connection card: ok');
} finally {
  await browser.close();
}
