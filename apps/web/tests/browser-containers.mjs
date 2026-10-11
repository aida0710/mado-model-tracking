import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createBrowserApi } from './browserApi.mjs';

const modulePath = process.env.MMT_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set MMT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.MMT_CHROMIUM_PATH ? { executablePath: process.env.MMT_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const api = createBrowserApi();
api.state.loggedIn = true;
await context.route((url) => url.pathname.startsWith('/api/'), api.route);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const projectBase = base + '/projects/' + api.state.project.id;
const dialog = () => page.getByRole('dialog').last();
const fill = (label, value) => dialog().getByLabel(label).fill(value);
const select = (label, value) => dialog().getByLabel(label).selectOption(value);
// getByLabel matches part of a label, and 'バージョン' is also in '編集元のコードバージョン'; the exact accessible
// name tells the two apart (the label text with its required mark is 'バージョン *', so exact getByLabel fails).
const versionField = () => dialog().getByRole('textbox', { name: 'バージョン', exact: true });
const clickSave = async () => {
  const versionSave = dialog().getByTestId('code-version-save');
  if (await versionSave.count()) await versionSave.click();
  else await dialog().getByRole('button', { name: '保存', exact: true }).click();
};
const waitClosed = () => page.getByRole('dialog').waitFor({ state: 'hidden' });
const codePosts = () =>
  api.state.calls.filter(
    (call) =>
      call.method === 'POST' && call.path.endsWith('/versions') && call.path.includes('/codes/'),
  );
const modelFamilies = '対応モデル系列（1行に1件）';
const commandLabel = '実行コマンド（引数のJSON配列）';
const image = 'registry.example.com/team/infer@sha256:' + 'a'.repeat(64);
async function fillCodeCommand() {
  await fill(commandLabel, '["python", "/app/infer.py"]');
  await fill(modelFamilies, 'test-family');
  await select('対応する実行種別', 'inference');
}
async function openNewVersion() {
  await page.getByRole('button', { name: 'バージョンを作成', exact: true }).click();
  await dialog().getByLabel('編集元のコードバージョン').selectOption('');
}
try {
  console.log('Browser containers: Docker, command, optional source, digest validation');
  await page.goto(projectBase + '/codes');
  await openNewVersion();
  await versionField().fill('docker-v1');
  await select('Runtime', 'docker');
  assert.equal(await dialog().getByLabel('ソース形式').inputValue(), 'none');
  assert.equal(await dialog().getByLabel('依存パッケージ（1行に1件）').count(), 0);
  await fill('Docker image（digest固定）', 'image:latest');
  await fillCodeCommand();
  await select('対応する実行種別', ['inference', 'evaluation']);
  await clickSave();
  await dialog()
    .getByRole('alert')
    .filter({ hasText: 'Docker imageはreference@sha256:' })
    .waitFor();
  assert.equal(codePosts().length, 0);
  await fill('Docker image（digest固定）', image);
  await fill('コンテナ内の作業ディレクトリ（任意）', 'app');
  await clickSave();
  await dialog().getByRole('alert').filter({ hasText: '絶対パス' }).waitFor();
  assert.equal(codePosts().length, 0);
  await fill('コンテナ内の作業ディレクトリ（任意）', '/app');
  await clickSave();
  await waitClosed();
  const dockerVersion = api.state.codeVersions.find((version) => version.version === 'docker-v1');
  assert.deepEqual(dockerVersion.runtime, { kind: 'docker', image, workingDirectory: '/app' });
  assert.equal(dockerVersion.source, null);
  assert.deepEqual(dockerVersion.requirements, []);
  await page.getByRole('button', { name: 'docker-v1', exact: true }).click();
  await page.locator('.version-detail').getByText(image, { exact: true }).waitFor();
  await page
    .locator('.version-detail')
    .getByText('["python","/app/infer.py"]', { exact: true })
    .waitFor();
  await page.reload();
  await page.locator('.version-detail').getByText(image, { exact: true }).waitFor();

  console.log('Browser containers: stored SIF and uploaded SIF SHA');
  const storedSif = {
    ...api.state.artifacts[0],
    id: '00000000-0000-4000-8000-000000008001',
    runId: null,
    path: 'images/stored.sif',
    sha256: 'b'.repeat(64),
  };
  api.state.artifacts.push(storedSif);
  await openNewVersion();
  await versionField().fill('singularity-v1');
  await select('Runtime', 'singularity');
  api.state.failProjectArtifacts = true;
  await fill('Artifactを検索', 'stored.sif');
  await dialog().getByRole('alert').filter({ hasText: 'artifact catalog unavailable' }).waitFor();
  api.state.failProjectArtifacts = false;
  await dialog().getByRole('button', { name: '再試行', exact: true }).click();
  await dialog()
    .getByLabel('SIF Artifact')
    .locator('option[value="' + storedSif.id + '"]')
    .waitFor({ state: 'attached' });
  await select('SIF Artifact', storedSif.id);
  assert.equal(await dialog().getByLabel('SHA256').inputValue(), storedSif.sha256);
  assert.equal(
    await dialog()
      .getByLabel('SHA256')
      .evaluate((input) => input.readOnly),
    true,
  );
  await fillCodeCommand();
  await select('ソース形式', 'inline');
  await fill('ファイルのパス', 'main.py');
  await dialog().getByRole('button', { name: 'ファイルを追加', exact: true }).click();
  await dialog().getByRole('textbox', { name: 'コードエディタ: main.py', exact: true }).focus();
  await page.keyboard.insertText('print(1)');
  await clickSave();
  await waitClosed();
  const singularityVersion = api.state.codeVersions.find(
    (version) => version.version === 'singularity-v1',
  );
  assert.deepEqual(singularityVersion.runtime, {
    kind: 'singularity',
    artifactId: storedSif.id,
    sha256: storedSif.sha256,
  });
  assert.equal(singularityVersion.source.kind, 'inline');
  await openNewVersion();
  await versionField().fill('apptainer-v1');
  await select('Runtime', 'apptainer');
  await dialog().getByRole('button', { name: 'Artifactをアップロード', exact: true }).click();
  // The resumable upload dialog: pick the file, check the path it fills in, then start.
  await dialog()
    .getByLabel('ファイルを選ぶ', { exact: true })
    .setInputFiles({
      name: 'uploaded.sif',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('SIF browser fixture'),
    });
  assert.equal(
    await dialog().getByRole('textbox', { name: '保存パス', exact: true }).inputValue(),
    'uploaded.sif',
  );
  await dialog().getByRole('button', { name: 'アップロードを開始', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Artifactをアップロード', exact: true })
    .waitFor({ state: 'hidden' });
  const uploadedSif = api.state.artifacts.find((artifact) => artifact.path === 'uploaded.sif');
  assert.ok(uploadedSif);
  assert.equal(await dialog().getByLabel('SIF Artifact').inputValue(), uploadedSif.id);
  assert.equal(await dialog().getByLabel('SHA256').inputValue(), uploadedSif.sha256);
  await fillCodeCommand();
  await clickSave();
  await waitClosed();
  assert.deepEqual(
    api.state.codeVersions.find((version) => version.version === 'apptainer-v1').runtime,
    {
      kind: 'apptainer',
      artifactId: uploadedSif.id,
      sha256: uploadedSif.sha256,
    },
  );

  console.log('Browser containers: target runtimes and launch compatibility');
  await page.goto(base + '/settings/computers');
  await page.getByRole('button', { name: 'コンピュータを追加', exact: true }).click();
  await fill('名前', 'Container target');
  await select('Executor', 'local');
  await fill('Host', 'localhost');
  await fill('SSHユーザー', 'test');
  await fill('作業ディレクトリ', '/test/container-work');
  await select('対応Runtime', ['python', 'docker', 'singularity', 'apptainer']);
  await fill('GPU ID（1行に1件）', '0\n1');
  await clickSave();
  await waitClosed();
  const containerTarget = api.state.targets.find((target) => target.name === 'Container target');
  assert.deepEqual(containerTarget.runtimeKinds, ['python', 'docker', 'singularity', 'apptainer']);
  // Whoever adds a computer owns it, private unless chosen otherwise; its owner runs Jobs on it.
  assert.equal(containerTarget.ownerUserId, api.state.user.id);
  assert.equal(containerTarget.visibility, 'private');
  await page.goto(projectBase + '/compute');
  await page
    .locator('tr')
    .filter({ hasText: 'Container target' })
    .getByText('Python, Docker, Singularity, Apptainer', { exact: true })
    .waitFor();
  await page.goto(projectBase + '/jobs');
  await page.getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  await fill('Run名', 'Container launch');
  await select('Experiments', api.state.experiments[0].id);
  await select('コードバージョン', dockerVersion.id);
  await dialog().getByRole('button', { name: '次へ', exact: true }).click();
  const targetOptions = await dialog()
    .getByLabel('Compute target')
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value));
  assert.ok(
    !targetOptions.includes(api.state.targets[0].id),
    'Python-only target is selectable for Docker',
  );
  await select('Compute target', containerTarget.id);
  await select('GPU ID · CPUのみ', '1');
  await dialog().getByRole('button', { name: '戻る', exact: true }).click();
  await select('コードバージョン', singularityVersion.id);
  await dialog().getByRole('button', { name: '次へ', exact: true }).click();
  assert.equal(await dialog().getByLabel('Compute target').inputValue(), '');
  assert.deepEqual(
    await dialog()
      .getByLabel('GPU ID · CPUのみ')
      .evaluate((input) => Array.from(input.selectedOptions, (option) => option.value)),
    [],
  );
  await select('Compute target', containerTarget.id);
  await dialog().getByRole('button', { name: '次へ', exact: true }).click();
  await dialog().getByText(storedSif.sha256, { exact: true }).waitFor();
  await dialog().getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  await waitClosed();
  assert.equal(api.state.jobs.at(-1).targetId, containerTarget.id);
  assert.deepEqual(api.state.jobs.at(-1).gpuIds, []);
  const manualRun = api.state.runs.find((run) => run.name === 'Container launch');
  assert.equal(manualRun.codeVersionId, singularityVersion.id);

  console.log('Browser automation: Project admin creates a fixed rule and retries failed save');
  api.state.user.isAdmin = false;
  await page.goto(projectBase + '/models');
  await page.getByRole('tab', { name: '自動実行ルール', exact: true }).click();
  await page.getByRole('button', { name: '自動実行ルールを作成', exact: true }).click();
  await fill('名前', 'Evaluate uploaded models');
  await select('対象モデル系列', 'test-family');
  await select('実行種別', 'evaluation');
  await select('Experiments', api.state.experiments[0].id);
  await select('コードバージョン', dockerVersion.id);
  assert.equal(
    await dialog()
      .getByLabel('Compute target')
      .locator('option[value="' + api.state.targets[0].id + '"]')
      .count(),
    0,
  );
  await select('Compute target', containerTarget.id);
  await select('GPU ID · CPUのみ', '0');
  await select('入力データセットバージョン', api.state.datasetVersions[0].id);
  await fill('パラメータ（JSON）', '{"batch_size":4}');
  await fill('タグ（JSON）', '{"suite":"regression"}');
  api.state.failNextAutomation = true;
  await dialog().getByRole('button', { name: '作成', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: 'automation storage unavailable' }).waitFor();
  assert.equal(await dialog().getByLabel('名前').inputValue(), 'Evaluate uploaded models');
  assert.equal(api.state.automationRules.length, 0);
  await dialog().getByRole('button', { name: '作成', exact: true }).click();
  await waitClosed();
  assert.equal(api.state.automationRules.length, 1);
  const rule = api.state.automationRules[0];
  assert.deepEqual(rule.modelFamilies, ['test-family']);
  assert.equal(rule.kind, 'evaluation');
  assert.equal(rule.codeVersionId, dockerVersion.id);
  assert.equal(rule.targetId, containerTarget.id);
  assert.deepEqual(rule.inputDatasetVersionIds, [api.state.datasetVersions[0].id]);
  assert.deepEqual(rule.parameters, { batch_size: 4 });
  await page.getByRole('button', { name: rule.name, exact: true }).click();
  await page.locator('.automation-rule-detail').getByText(image, { exact: true }).waitFor();
  const immutableSettings = { ...rule };
  api.state.failNextAutomationToggle = true;
  await page.getByRole('button', { name: rule.name + ': 無効にする', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'toggle failed' }).waitFor();
  assert.equal(rule.enabled, true);
  await page.getByRole('button', { name: rule.name + ': 無効にする', exact: true }).click();
  await page.getByRole('button', { name: rule.name + ': 有効にする', exact: true }).waitFor();
  assert.deepEqual(rule, { ...immutableSettings, enabled: false });
  assert.deepEqual(
    api.state.calls
      .filter((call) => call.method === 'PATCH' && call.path.includes('/automation-rules/'))
      .at(-1).body,
    { enabled: false },
  );
  await page.getByRole('button', { name: rule.name + ': 有効にする', exact: true }).click();
  await page.getByRole('button', { name: rule.name + ': 無効にする', exact: true }).waitFor();

  console.log('Browser automation: enrollment outcome, current statuses and Run/Job links');
  const job = api.state.jobs.at(-1);
  // A first-stage automatic execution of the rule, as GET .../automation-executions returns it.
  const firstStageExecution = (fields) => ({
    projectId: api.state.project.id,
    ruleId: rule.id,
    modelVersionId: api.state.modelVersions[0].id,
    runId: null,
    jobId: null,
    sourceRunId: null,
    runStatus: null,
    jobStatus: null,
    error: null,
    triggerRunId: null,
    pipelineRootExecutionId: fields.id,
    attempt: 1,
    source: 'automatic',
    requestedBy: null,
    retryOfExecutionId: null,
    createdAt: '2026-10-08T00:01:00Z',
    ...fields,
  });
  api.state.automationExecutions.push(
    firstStageExecution({
      id: 'execution-queued',
      runId: manualRun.id,
      jobId: job.id,
      status: 'queued',
      runStatus: 'finished',
      jobStatus: 'finished',
    }),
    firstStageExecution({ id: 'execution-failed', status: 'failed', error: 'Target disabled' }),
    firstStageExecution({ id: 'execution-skipped', status: 'skipped', error: 'No model weights' }),
  );
  await page.getByRole('tab', { name: '自動実行履歴', exact: true }).click();
  await page.getByRole('button', { name: '再読み込み', exact: true }).last().click();
  for (const label of [
    'Jobを登録',
    '起動に失敗',
    '起動せず',
    'Target disabled',
    'No model weights',
  ])
    await page.getByText(label, { exact: true }).waitFor();
  for (const label of ['起動結果', 'Runの状態', 'Jobの状態'])
    assert.equal(await page.getByRole('columnheader', { name: label, exact: true }).count(), 1);
  assert.equal(
    await page.getByRole('link', { name: 'Runを開く', exact: true }).getAttribute('href'),
    '/projects/' + api.state.project.id + '/runs/' + manualRun.id,
  );
  assert.equal(
    await page.getByRole('link', { name: 'Jobを開く', exact: true }).getAttribute('href'),
    '/projects/' + api.state.project.id + '/jobs?job=' + job.id,
  );
  await page.getByRole('link', { name: 'Runを開く', exact: true }).click();
  await page.getByRole('heading', { name: manualRun.name, exact: true }).waitFor();
  await page.goto(projectBase + '/models');
  await page.getByRole('tab', { name: '自動実行履歴', exact: true }).click();
  await page.getByRole('link', { name: 'Jobを開く', exact: true }).click();
  // The Job's detail is headed by its Run's name and lists the Job ID.
  const jobDetail = page.locator('.job-detail');
  await jobDetail.getByRole('heading', { name: manualRun.name, exact: true }).waitFor();
  await jobDetail.getByText(job.id, { exact: true }).waitFor();

  console.log('Browser automation: Viewer/Editor read-only and global admin');
  for (const role of ['viewer', 'editor']) {
    api.state.project.role = role;
    api.state.user.isAdmin = false;
    await page.goto(projectBase + '/models');
    await page.getByRole('tab', { name: '自動実行ルール', exact: true }).click();
    await page.getByRole('button', { name: rule.name, exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '自動実行ルールを作成', exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole('button', { name: rule.name + ': 無効にする', exact: true }).count(),
      0,
    );
    await page.getByRole('tab', { name: '自動実行履歴', exact: true }).click();
    await page.getByRole('link', { name: 'Jobを開く', exact: true }).waitFor();
  }
  api.state.user.isAdmin = true;
  api.state.project.role = 'viewer';
  await page.goto(projectBase + '/models');
  await page.getByRole('tab', { name: '自動実行ルール', exact: true }).click();
  await page.getByRole('button', { name: '自動実行ルールを作成', exact: true }).waitFor();
  await page.getByRole('button', { name: rule.name + ': 無効にする', exact: true }).waitFor();
  await page.getByRole('button', { name: 'ダークテーマ', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('button', { name: rule.name, exact: true }).click();
  await page.locator('.automation-rule-detail').getByText(image, { exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  console.log('Container and automation browser checks passed.');
} finally {
  await browser.close();
}
