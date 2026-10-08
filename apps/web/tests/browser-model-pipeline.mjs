// Model version page with a mocked API: the version link in the registry opens the page, the
// automation table follows queued → running → finished by polling, failed and skipped reasons are
// shown, evaluation metrics are summarized against the baseline, and a viewer sees no operations.
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
const { project, models, modelVersions } = api.state;
const model = models[0];
const version = modelVersions[0];
const now = '2026-10-08T00:00:00Z';
const ids = {
  training: '00000000-0000-4000-8000-000000009001',
  baseline: '00000000-0000-4000-8000-000000009002',
  inferenceRule: '00000000-0000-4000-8000-000000009101',
  evaluationRule: '00000000-0000-4000-8000-000000009102',
  skippedRule: '00000000-0000-4000-8000-000000009103',
  inferenceRun: '00000000-0000-4000-8000-000000009201',
  evaluationRun: '00000000-0000-4000-8000-000000009202',
  manualRun: '00000000-0000-4000-8000-000000009203',
  baselineRun: '00000000-0000-4000-8000-000000009204',
};
version.sourceRunId = ids.training;
model.aliases = { production: ids.baseline };

const rule = (overrides) => ({
  projectId: project.id,
  enabled: true,
  modelFamilies: [model.family],
  trigger: 'model_registered',
  upstreamRuleId: null,
  experimentId: api.state.experiments[0].id,
  codeVersionId: api.state.codeVersions[0].id,
  targetId: api.state.targets[0].id,
  gpuIds: [],
  inputDatasetVersionIds: [],
  parameters: {},
  tags: {},
  maxAttempts: 1,
  summaryMetrics: [],
  createdBy: api.state.user.id,
  createdAt: now,
  ...overrides,
});
const rules = [
  rule({ id: ids.inferenceRule, name: '推論rule', kind: 'inference' }),
  rule({
    id: ids.evaluationRule,
    name: '評価rule',
    kind: 'evaluation',
    trigger: 'upstream_run_finished',
    upstreamRuleId: ids.inferenceRule,
    summaryMetrics: ['wer'],
  }),
  rule({ id: ids.skippedRule, name: '保留rule', kind: 'processing' }),
];

// The test moves the evaluation through queued, running and finished; the page must pick each
// state up by polling. executionReads counts the reads to check that polling stops.
const evaluationStates = [
  { runStatus: 'queued', jobStatus: 'queued', runStartedAt: null, runEndedAt: null },
  { runStatus: 'running', jobStatus: 'running', runStartedAt: now, runEndedAt: null },
  {
    runStatus: 'finished',
    jobStatus: 'finished',
    runStartedAt: now,
    runEndedAt: '2026-10-08T00:02:00Z',
  },
];
let evaluationStage = 0;
let executionReads = 0;
function executions() {
  const evaluation = evaluationStates[evaluationStage];
  executionReads += 1;
  const execution = (overrides) => ({
    projectId: project.id,
    modelVersionId: version.id,
    runId: null,
    jobId: null,
    sourceRunId: ids.training,
    runStatus: null,
    jobStatus: null,
    runStartedAt: null,
    runEndedAt: null,
    error: null,
    triggerRunId: null,
    attempt: 1,
    source: 'automatic',
    requestedBy: null,
    createdAt: now,
    ...overrides,
  });
  return [
    execution({
      id: '00000000-0000-4000-8000-000000009303',
      ruleId: ids.evaluationRule,
      status: 'queued',
      runId: ids.evaluationRun,
      jobId: '00000000-0000-4000-8000-000000009403',
      triggerRunId: ids.inferenceRun,
      pipelineRootExecutionId: '00000000-0000-4000-8000-000000009301',
      createdAt: '2026-10-08T00:01:00Z',
      ...evaluation,
    }),
    execution({
      id: '00000000-0000-4000-8000-000000009302',
      ruleId: ids.skippedRule,
      status: 'skipped',
      pipelineRootExecutionId: '00000000-0000-4000-8000-000000009302',
      error: 'source_run_unsuccessful: 学習Runが成功しなかったため起動しません',
    }),
    execution({
      id: '00000000-0000-4000-8000-000000009301',
      ruleId: ids.inferenceRule,
      status: 'queued',
      runId: ids.inferenceRun,
      jobId: '00000000-0000-4000-8000-000000009401',
      pipelineRootExecutionId: '00000000-0000-4000-8000-000000009301',
      runStatus: 'finished',
      jobStatus: 'finished',
      runStartedAt: now,
      runEndedAt: '2026-10-08T00:00:40Z',
    }),
  ];
}

const summary = (overrides) => ({
  kind: 'evaluation',
  status: 'finished',
  modelVersionId: version.id,
  codeVersionId: api.state.codeVersions[0].id,
  parentRunId: null,
  latestMetrics: {},
  parameters: {},
  referenceDatasetVersionIds: [api.state.datasetVersions[0].id],
  upstreamDatasetVersionIds: [],
  automatic: false,
  ruleId: null,
  executionId: null,
  pipelineRootExecutionId: null,
  createdAt: now,
  startedAt: now,
  endedAt: now,
  ...overrides,
});
const evaluationRunsFinished = () => evaluationStage === evaluationStates.length - 1;
function candidateRuns() {
  const isFinished = evaluationRunsFinished();
  return [
    summary({
      id: ids.evaluationRun,
      name: '自動評価Run',
      status: isFinished ? 'finished' : 'running',
      parentRunId: ids.inferenceRun,
      latestMetrics: isFinished ? { wer: 0.2, cer: 0.1 } : {},
      upstreamDatasetVersionIds: ['00000000-0000-4000-8000-000000009501'],
      automatic: true,
      ruleId: ids.evaluationRule,
      executionId: '00000000-0000-4000-8000-000000009303',
      pipelineRootExecutionId: '00000000-0000-4000-8000-000000009301',
      createdAt: '2026-10-08T00:01:00Z',
      endedAt: isFinished ? '2026-10-08T00:02:00Z' : null,
    }),
    summary({
      id: ids.manualRun,
      name: '手動評価Run',
      latestMetrics: { wer: 0.5 },
      createdAt: '2026-10-07T00:00:00Z',
      endedAt: '2026-10-07T00:10:00Z',
    }),
    summary({
      id: ids.inferenceRun,
      name: '推論Run',
      kind: 'inference',
      parentRunId: ids.training,
      automatic: true,
      ruleId: ids.inferenceRule,
    }),
  ];
}

const projectPath = `/projects/${project.id}`;
async function routeModelPipeline(route) {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^\/api/, '');
  const reply = (payload) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  if (path === `${projectPath}/model-versions/${version.id}`)
    return reply({ version, model, aliases: [] });
  if (path === `${projectPath}/model-versions/${version.id}/evaluations`)
    return reply({ modelVersionId: version.id, items: candidateRuns(), nextCursor: null });
  if (path === `${projectPath}/model-versions/${ids.baseline}/evaluations`)
    return reply({
      modelVersionId: ids.baseline,
      items: [
        summary({
          id: ids.baselineRun,
          name: '基準版の評価',
          modelVersionId: ids.baseline,
          latestMetrics: { wer: 0.25, cer: 0.1 },
          automatic: true,
          ruleId: ids.evaluationRule,
        }),
      ],
      nextCursor: null,
    });
  if (path === `${projectPath}/automation-executions` && url.searchParams.get('modelVersionId'))
    return reply({ items: executions(), nextCursor: null });
  if (path === `${projectPath}/automation-rules`) return reply({ items: rules });
  if (path === `${projectPath}/runs/${ids.training}`)
    return reply({
      ...api.state.runs[0],
      id: ids.training,
      name: '学習Run',
      kind: 'training',
      status: 'finished',
    });
  if (path === `${projectPath}/promotion-evaluations`) return reply({ items: [], nextCursor: null });
  if (path.endsWith('/evaluation-comparison'))
    return reply({
      status: 'baseline_not_evaluated',
      modelId: model.id,
      candidateVersionId: version.id,
      baselineAlias: 'production',
      baselineVersionId: ids.baseline,
      candidateRunId: null,
      baselineRunId: null,
      referenceDatasetVersionIds: [],
      codeVersionId: null,
      evaluationRuleId: null,
      metrics: [],
    });
  return api.route(route);
}
await context.route((url) => url.pathname.startsWith('/api/'), routeModelPipeline);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const versionPage = page.locator('.model-version-page');
const automation = () => page.getByRole('region', { name: '自動実行' });
// The page polls every 5 seconds while work is in progress.
const POLL_TIMEOUT_MS = 20000;

try {
  console.log('Model pipeline: registry version link opens the version page');
  await page.goto(`${base}${projectPath}/models`);
  await page.getByRole('button', { name: model.name, exact: true }).click();
  await page.getByRole('link', { name: version.version, exact: true }).click();
  await page.waitForURL(`**${projectPath}/models/${model.id}/versions/${version.id}`);
  await versionPage.getByRole('heading', { name: `${model.name} / ${version.version}` }).waitFor();
  await versionPage.getByRole('link', { name: '学習Run' }).first().waitFor();

  console.log('Model pipeline: automation states follow queued → running → finished');
  const evaluationRow = () => automation().locator('tr', { hasText: '評価rule' });
  await evaluationRow().getByText('Queued').first().waitFor();
  evaluationStage = 1;
  await evaluationRow().getByText('Running').first().waitFor({ timeout: POLL_TIMEOUT_MS });
  evaluationStage = 2;
  await automation()
    .locator('tr', { hasText: '評価rule' })
    .getByText('Finished')
    .first()
    .waitFor({ timeout: POLL_TIMEOUT_MS });
  await automation().getByText('起動せず（学習Runが失敗・停止）').waitFor();
  await automation().getByText('source_run_unsuccessful: 学習Runが成功しなかったため起動しません').waitFor();
  assert.ok(await automation().locator('tr', { hasText: '評価rule' }).getByText('0h 2m').count());
  // Polling stops once nothing is in progress.
  const readsAfterFinish = executionReads;
  await page.waitForTimeout(6000);
  assert.ok(executionReads - readsAfterFinish <= 1, 'polling stops after the work has ended');

  console.log('Model pipeline: evaluation summary, automatic marks and baseline sign');
  const results = page.getByRole('region', { name: '評価結果' });
  await results.getByText('自動評価（評価rule）').waitFor();
  await results.getByText('手動', { exact: true }).waitFor();
  const werRow = results.locator('tr', { hasText: /^wer/ }).first();
  await werRow.getByText('0.2', { exact: true }).waitFor();
  await werRow.getByText('0.25', { exact: true }).waitFor();
  await werRow.getByText('－（基準より小さい）').waitFor();
  const headers = await results.locator('table').last().locator('th').allTextContents();
  assert.ok(headers.indexOf('wer') < headers.indexOf('cer'), 'summaryMetrics come first');
  if (process.env.MMT_SCREENSHOT_PATH)
    await page.screenshot({ path: process.env.MMT_SCREENSHOT_PATH, fullPage: true });

  console.log('Model pipeline: a viewer sees no operations on the page');
  project.role = 'viewer';
  await page.reload();
  await versionPage.getByRole('heading', { name: `${model.name} / ${version.version}` }).waitFor();
  await results.getByText('自動評価（評価rule）').waitFor();
  const buttons = await versionPage.getByRole('button').allTextContents();
  const labels = await versionPage.getByRole('button').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label') ?? element.textContent),
  );
  assert.deepEqual(labels, ['再読み込み'], `unexpected buttons: ${buttons.join(', ')}`);

  assert.deepEqual(pageErrors, []);
  console.log('Model pipeline: ok');
} finally {
  await browser.close();
}
