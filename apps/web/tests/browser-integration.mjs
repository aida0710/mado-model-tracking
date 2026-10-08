import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openProjectCreation } from './projectCreation.mjs';

const { chromium } = await import(pathToFileURL(process.env.MMT_PLAYWRIGHT_MODULE).href);
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
assert.equal(
  new URL(base).hostname,
  '127.0.0.1',
  'This verification creates records in the local development app',
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.MMT_CHROMIUM_PATH,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
const json = async (path) => {
  const response = await page.request.get(`${base}/api${path}`);
  assert.equal(response.ok(), true, `${path}: ${response.status()}`);
  return response.json();
};
const fill = (name, value) =>
  page.getByRole('dialog').getByLabel(name, { exact: false }).fill(value);
const select = (name, value) =>
  page.getByRole('dialog').getByLabel(name, { exact: false }).selectOption(value);
const submit = async (name = '保存') => {
  const versionSave = page.getByRole('dialog').getByTestId('code-version-save');
  if (name === '保存' && await versionSave.count()) await versionSave.click();
  else await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
};
const screenshot = async (name) => {
  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
  }
};
try {
  await page.goto(base);
  await page.getByLabel('メールアドレス').fill('admin@localhost');
  await page.getByLabel('表示名').fill('開発管理者');
  await page.getByRole('button', { name: '開発モードでログイン' }).click();
  await page.getByRole('navigation').waitFor();
  const projects = await json('/projects');
  const demo = projects.items.find((project) => project.name === 'Mado Model Tracking Demo');
  if (demo) {
    await page.goto(`${base}/projects/${demo.id}/experiments`);
    await page.getByRole('link', { name: 'CPU linear regression', exact: true }).waitFor();
    await screenshot('runs-real-light');
    const demoRuns = (await json(`/projects/${demo.id}/runs`)).items;
    const training = demoRuns.find((run) => run.name === 'CPU linear regression');
    await page.goto(`${base}/projects/${demo.id}/runs/${training.id}`);
    await page.getByLabel('メトリクス名', { exact: true }).waitFor();
    await screenshot('run-real-detail');
    const audio = demoRuns.find((run) => run.name === 'Generated audio sample');
    await page.goto(`${base}/projects/${demo.id}/runs/${audio.id}?tab=artifacts`);
    await page.locator('audio').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelector('audio')?.duration === 1);
    console.log('Real API: metrics chart and streamed one-second audio passed');
  }

  console.log('Real API: create project and experiment');
  await openProjectCreation(page, { base, projects: (await json('/projects')).items });
  const projectName = `Web UI verification ${new Date().toISOString()}`;
  await fill('名前', projectName);
  await fill('説明', 'ブラウザからの登録・保存・再読み込みを確認するローカル検証記録');
  await submit('作成');
  await page.getByRole('heading', { name: 'Runs', exact: true }).waitFor();
  const projectId = (await json('/projects')).items.find(
    (project) => project.name === projectName,
  ).id;
  const projectBase = `${base}/projects/${projectId}`;
  await page.getByRole('button', { name: '実験を作成', exact: true }).click();
  await fill('名前', 'UI登録・起動検証');
  await submit();
  await page.getByRole('heading', { name: 'UI登録・起動検証', exact: true }).waitFor();
  const experimentId = (await json(`/projects/${projectId}/experiments`)).items[0].id;
  await page.getByRole('button', { name: 'Runを作成', exact: true }).click();
  await fill('名前', 'UI artifact registration');
  await select('実行種別', 'processing');
  await submit('作成');
  await page.getByRole('heading', { name: 'UI artifact registration', exact: true }).waitFor();
  const preparationRun = (await json(`/projects/${projectId}/runs`)).items[0];
  await page.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  for (const [name, mimeType, content] of [
    ['points.csv', 'text/csv', 'x,y\n0,1\n1,3\n2,5\n'],
    ['weights.json', 'application/json', '{"slope":2,"intercept":1}'],
  ]) {
    await page.getByRole('button', { name: 'Artifactをアップロード', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('ファイル', { exact: true })
      .setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
    await submit('アップロード');
    await page.getByRole('button', { name, exact: true }).waitFor();
  }
  const artifacts = (await json(`/projects/${projectId}/runs/${preparationRun.id}/artifacts`))
    .items;
  const pointsArtifact = artifacts.find((artifact) => artifact.path === 'points.csv');
  const weightsArtifact = artifacts.find((artifact) => artifact.path === 'weights.json');
  assert.ok(pointsArtifact.sha256.length === 64);

  console.log('Real API: code, model and dataset versions');
  await page.goto(`${projectBase}/codes`);
  await page.getByRole('button', { name: 'コードを登録', exact: true }).click();
  await fill('名前', 'UI linear training');
  await submit();
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  await fill('Version', 'v1');
  await select('ソース形式', 'inline');
  await fill('ファイルのパス', 'main.py');
  await page.getByRole('dialog').getByRole('button', { name: 'ファイルを追加', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'コードエディタ: main.py', exact: true }).focus();
  await page.keyboard.insertText('import json\npairs = [(0, 1), (1, 3), (2, 5)]\nprint(json.dumps({"mean_y": sum(y for _, y in pairs) / len(pairs)}))\n');
  await fill('実行コマンド', '["python3","main.py"]');
  await fill('対応モデル系列', 'ui-linear');
  await select('対応する実行種別', ['training', 'finetuning']);
  await submit();
  await page.getByRole('button', { name: 'v1', exact: true }).waitFor();
  const code = (await json(`/projects/${projectId}/codes`)).items[0];
  const codeVersion = (await json(`/projects/${projectId}/codes/${code.id}/versions`)).items[0];

  await page.goto(`${projectBase}/models`);
  await page.getByRole('button', { name: 'モデルを登録', exact: true }).click();
  await fill('名前', 'UI linear model');
  await fill('Family', 'ui-linear');
  await submit();
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  await fill('Version', 'v1');
  await fill('Artifact ID', weightsArtifact.id);
  await submit();
  await page.getByRole('button', { name: 'v1', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Aliasを設定', exact: true }).click();
  await fill('Alias', 'verification');
  await submit();
  await page.getByText('verification', { exact: true }).waitFor();
  const model = (await json(`/projects/${projectId}/models`)).items[0];
  const modelVersion = (await json(`/projects/${projectId}/models/${model.id}/versions`)).items[0];

  await page.goto(`${projectBase}/datasets`);
  await page.getByRole('button', { name: 'データセットを登録', exact: true }).click();
  await fill('名前', 'UI linear points');
  await fill('Namespace', 'verification');
  await submit();
  await page.getByRole('button', { name: '版を作成', exact: true }).click();
  await fill('Version', 'v1');
  await fill('URI', `artifact://${pointsArtifact.id}`);
  await fill('Digest', `sha256:${pointsArtifact.sha256}`);
  await select('生成元Run', preparationRun.id);
  await submit();
  await page.getByRole('button', { name: 'v1', exact: true }).waitFor();
  const dataset = (await json(`/projects/${projectId}/datasets`)).items[0];
  const datasetVersion = (await json(`/projects/${projectId}/datasets/${dataset.id}/versions`))
    .items[0];

  console.log('Real API: training launch, cancellation and retry');
  await page.goto(`${projectBase}/jobs`);
  const targets = (await json('/targets')).items;
  const localTarget = targets.find((target) => target.executor === 'local' && target.enabled);
  assert.ok(localTarget, 'The root-managed local executor is required for this verification');
  await page.getByRole('button', { name: 'ジョブを起動', exact: true }).click();
  await fill('Run name', 'UI training enqueue');
  await select('Experiments', experimentId);
  await select('実行種別', 'training');
  await select('モデル版', modelVersion.id);
  await select('コード版', codeVersion.id);
  await select('入力データセット版', [datasetVersion.id]);
  await page.getByRole('dialog').getByRole('button', { name: '次へ', exact: true }).click();
  await select('Compute target', localTarget.id);
  await page.getByRole('dialog').getByRole('button', { name: '次へ', exact: true }).click();
  await submit('ジョブを起動');
  await page.getByRole('button', { name: '停止を要求', exact: true }).click();
  await submit();
  await page.getByRole('button', { name: '新しいRunで再実行', exact: true }).waitFor();
  await page.getByRole('button', { name: '新しいRunで再実行', exact: true }).click();
  await submit();
  await page.getByRole('heading', { name: /UI training enqueue \(retry 2\)/ }).waitFor();
  const jobs = (await json(`/projects/${projectId}/jobs`)).items;
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0].runId, jobs[1].runId);
  await page.goto(`${projectBase}/jobs`);
  await page.getByRole('button', { name: '停止を要求', exact: true }).click();
  await submit();

  for (const [route, heading] of [
    ['lineage', 'Lineage'],
    ['compute', 'Compute'],
    ['plugins', 'Plugins'],
    ['settings', 'Settings'],
  ]) {
    await page.goto(`${projectBase}/${route}`);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  }
  await page.getByLabel('説明', { exact: true }).fill('ブラウザで保存したプロジェクト設定');
  await page.getByRole('button', { name: '保存', exact: true }).first().click();
  await page.getByText('プロジェクト設定を保存しました', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'トークンを作成', exact: true }).click();
  await fill('名前', 'UI verification personal token');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText(/トークンは一度だけ表示/).waitFor();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '閉じる', exact: true })
    .last()
    .click();
  await page.getByRole('button', { name: '失効', exact: true }).click();
  await submit('失効');
  await page
    .getByText('UI verification personal token', { exact: true })
    .waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByLabel('説明', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('説明', { exact: true }).inputValue(),
    'ブラウザで保存したプロジェクト設定',
  );
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'Real API browser integration passed',
      projectId,
      verified: [
        'project/experiment/run registration',
        'artifact streaming/upload/digest',
        'code/model/dataset versions',
        'alias',
        'input/output lineage',
        'training enqueue/cancel/retry',
        'members rendering',
        'token create/revoke',
        'settings persistence',
      ],
    }),
  );
} finally {
  await browser.close();
}
