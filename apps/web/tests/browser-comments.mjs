// Run descriptions and comment threads against a development API (AUTH_MODE=development):
// the description saved on the Run page is what MLflow's get-run returns as mlflow.note.content,
// raw HTML and javascript: links in Markdown never run, comments can be posted, replied to,
// edited and deleted, a viewer sees no input, and the model version page has its own thread.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
assert.equal(
  new URL(base).hostname,
  '127.0.0.1',
  'This verification creates records in the local development app',
);
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const errors = [];

async function signIn(email, displayName) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  // A dialog would mean injected script ran (alert/confirm from the Markdown below).
  page.on('dialog', async (dialog) => {
    errors.push(`unexpected dialog: ${dialog.message()}`);
    await dialog.dismiss();
  });
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('表示名').fill(displayName);
  const loginButton = page.getByRole('button', { name: '開発モードでログイン' });
  await loginButton.click();
  // A new user has no Project yet, so the app shell may not show navigation.
  await loginButton.waitFor({ state: 'detached' });
  return page;
}

function apiClient(page) {
  const call = async (method, path, body) => {
    const response = await page.request.fetch(`${base}/api${path}`, {
      method,
      headers: { Origin: new URL(base).origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { data: JSON.stringify(body) }),
    });
    assert.equal(response.ok(), true, `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? undefined : response.json();
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
  };
}

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
}

const DESCRIPTION = [
  '## 学習条件',
  '',
  '| 項目 | 値 |',
  '| --- | --- |',
  '| lr | 0.001 |',
  '',
  '- [x] 前処理を確認',
  '- [ ] 評価を回す',
  '',
  '```python',
  'print("ok")',
  '```',
  '',
  '<script>window.__mmtInjected = "script"</script>',
  '<img src="x" onerror="window.__mmtInjected = \'img\'">',
  '',
  '[危ないリンク](javascript:window.__mmtInjected="link")',
  '[MLflowの資料](https://mlflow.org/docs/latest/)',
  '![外部画像](https://example.com/tracking-pixel.png)',
].join('\n');

try {
  const admin = await signIn('comments-admin@localhost', 'コメント管理者');
  const adminApi = apiClient(admin);
  const project = await adminApi.post('/projects', {
    name: `Comments verification ${new Date().toISOString()}`,
  });
  const projectBase = `${base}/projects/${project.id}`;
  const experiment = await adminApi.post(`/projects/${project.id}/experiments`, {
    name: 'コメント検証',
  });
  const run = await adminApi.post(`/projects/${project.id}/runs`, {
    experimentId: experiment.id,
    name: 'note and comments',
    kind: 'training',
  });

  console.log('Run description: limit, preview and save');
  await admin.goto(`${projectBase}/runs/${run.id}?tab=details`);
  await admin.getByText('説明はまだありません').waitFor();
  await admin.getByRole('button', { name: '説明を編集' }).click();
  const descriptionInput = admin.getByRole('textbox', { name: '説明' });
  await descriptionInput.fill('x'.repeat(8001));
  await admin.getByText('1 文字超過しています').waitFor();
  const saveDescription = admin.locator('.run-description').getByRole('button', { name: '保存' });
  assert.equal(await saveDescription.isDisabled(), true, 'Over-limit descriptions must not be sent');
  await descriptionInput.fill(DESCRIPTION);
  await admin.getByText(`残り ${8000 - DESCRIPTION.length} 文字`).waitFor();
  await admin.locator('.run-description').getByRole('tab', { name: 'プレビュー' }).click();
  await admin.locator('.run-description table').waitFor();
  await admin.locator('.run-description').getByRole('tab', { name: '編集' }).click();
  await saveDescription.click();
  await admin.getByRole('button', { name: '説明を編集' }).waitFor();

  const view = admin.locator('.run-description .markdown-view');
  await view.locator('table').waitFor();
  assert.equal(await view.locator('input[type=checkbox]').count(), 2);
  assert.equal(await view.locator('pre code').textContent(), 'print("ok")\n');
  assert.equal(await view.locator('script').count(), 0, 'Raw HTML must not become elements');
  assert.ok((await view.textContent()).includes('<script>'), 'Raw HTML is shown as text');
  assert.equal(await view.locator('a[href^="javascript"]').count(), 0);
  assert.ok((await view.textContent()).includes('<javascript:window.__mmtInjected="link">'));
  assert.equal(await view.locator('img').count(), 0, 'External images are not loaded');
  assert.equal(
    await view.getByRole('link', { name: '外部画像' }).getAttribute('href'),
    'https://example.com/tracking-pixel.png',
  );
  assert.equal(
    await view.getByRole('link', { name: 'MLflowの資料' }).getAttribute('rel'),
    'noopener noreferrer nofollow',
  );
  await view.getByText('危ないリンク').click();
  assert.equal(await admin.evaluate(() => window.__mmtInjected), undefined);
  await screenshot(admin, 'run-description');

  console.log('Run description: MLflow get-run returns the same mlflow.note.content');
  const { token } = await adminApi.post('/tokens', {
    name: 'comments verification',
    kind: 'personal',
    projectId: project.id,
    scopes: ['read'],
  });
  const mlflowResponse = await admin.request.get(
    `${base}/api/mlflow/projects/${project.id}/api/2.0/mlflow/runs/get?run_id=${run.id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(mlflowResponse.ok(), true, `MLflow get-run: ${mlflowResponse.status()}`);
  const mlflowTags = (await mlflowResponse.json()).run.data.tags;
  assert.equal(mlflowTags.find((tag) => tag.key === 'mlflow.note.content')?.value, DESCRIPTION);
  await admin.reload();
  await admin.locator('.run-description table').waitFor();

  console.log('Comments: post, reply, edit and delete');
  const thread = admin.locator('.comment-thread');
  const newComment = thread.getByRole('textbox', { name: 'コメント' }).last();
  await thread.getByRole('button', { name: '投稿' }).click();
  await thread.getByText('本文を入力してください').waitFor();
  await newComment.fill('学習率を **下げた** バージョンです。<img src=x onerror="alert(1)">');
  await thread.getByRole('button', { name: '投稿' }).click();
  const root = thread.locator('.comment-thread-group').first();
  await root.locator('strong', { hasText: '下げた' }).waitFor();
  assert.equal(await root.locator('.markdown-view img').count(), 0);
  await root.getByRole('button', { name: '返信' }).click();
  await root.getByRole('textbox', { name: '返信' }).fill('評価も回します');
  await root.getByRole('button', { name: '返信' }).last().click();
  const reply = root.locator('.comment-replies .comment-item').first();
  await reply.getByText('評価も回します').waitFor();
  await reply.getByRole('button', { name: '編集' }).click();
  await reply.getByRole('textbox', { name: '編集' }).fill('評価も回しました');
  await reply.getByRole('button', { name: '保存' }).click();
  await reply.getByText('評価も回しました').waitFor();
  await reply.getByText('編集済み').waitFor();
  await newComment.fill('消すコメント');
  await thread.getByRole('button', { name: '投稿' }).click();
  const second = thread.locator('.comment-thread-group').nth(1);
  await second.getByText('消すコメント').waitFor();
  await second.getByRole('button', { name: '削除' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: '削除' }).click();
  await second.getByText('削除されました').waitFor();
  await admin.reload();
  await thread.getByText('評価も回しました').waitFor();
  await thread.getByText('削除されました').waitFor();
  const stored = await adminApi.get(
    `/projects/${project.id}/comments?targetType=run&targetId=${run.id}`,
  );
  assert.deepEqual(
    stored.items.map((comment) => [comment.parentCommentId !== null, comment.deleted]),
    [
      [false, false],
      [true, false],
      [false, true],
    ],
  );
  await screenshot(admin, 'run-comments');

  console.log('Viewer: reads the description and comments without any input');
  const viewer = await signIn('comments-viewer@localhost', 'コメント閲覧者');
  const viewerUser = (await apiClient(viewer).get('/auth/me')).user;
  await adminApi.put(`/projects/${project.id}/members/${viewerUser.id}`, { role: 'viewer' });
  await viewer.goto(`${projectBase}/runs/${run.id}?tab=details`);
  await viewer.locator('.comment-thread').getByText('評価も回しました').waitFor();
  await viewer.locator('.run-description table').waitFor();
  assert.equal(await viewer.getByRole('button', { name: '説明を編集' }).count(), 0);
  assert.equal(await viewer.locator('.comment-thread textarea').count(), 0);
  assert.equal(await viewer.locator('.comment-thread').getByRole('button', { name: '返信' }).count(), 0);
  assert.equal(await viewer.locator('.comment-thread').getByRole('button', { name: '削除' }).count(), 0);
  await screenshot(viewer, 'run-comments-viewer');

  console.log('Model version page: a separate thread');
  const model = await adminApi.post(`/projects/${project.id}/models`, {
    name: `comments-model-${Date.now()}`,
    family: 'asr',
  });
  const version = await adminApi.post(`/projects/${project.id}/models/${model.id}/versions`, {
    sourceRunId: run.id,
  });
  await admin.goto(`${projectBase}/models/${model.id}/versions/${version.id}`);
  const versionThread = admin.locator('.comment-thread');
  await versionThread.getByText('コメントはまだありません').waitFor();
  await versionThread.getByRole('textbox', { name: 'コメント' }).fill('このバージョンを本番候補にします');
  await versionThread.getByRole('button', { name: '投稿' }).click();
  await versionThread.locator('.comment-item', { hasText: 'このバージョンを本番候補にします' }).waitFor();
  const versionComments = await adminApi.get(
    `/projects/${project.id}/comments?targetType=model_version&targetId=${version.id}`,
  );
  assert.equal(versionComments.items.length, 1);
  await screenshot(admin, 'model-version-comments');

  assert.deepEqual(errors, []);
  console.log('Run description and comment thread verification passed');
} catch (failure) {
  // Keep what each open page showed when a step failed.
  for (const [index, page] of browser.contexts().flatMap((context) => context.pages()).entries())
    await screenshot(page, `failure-${index}`);
  console.error('page errors:', errors);
  throw failure;
} finally {
  await browser.close();
}
