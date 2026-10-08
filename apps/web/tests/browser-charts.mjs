// Browser check for the chart panels of Run detail, Compare and the Run list, system metrics
// with worker and MLflow names, and resumed segments. The API is the isolated browser-test API
// plus the metric series, groups, comparison and resume-event endpoints below.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
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
const base = process.env.MMT_WEB_URL ?? 'http://127.0.0.1:5182';
const screenshotDirectory = process.env.MMT_SCREENSHOT_DIR;
// The acceptance bound for the first chart of a Run with 100,000 points per metric.
const FIRST_DRAW_BUDGET_MS = 2000;
const LARGE_RUN_POINTS = 100_000;
const STEP_SECONDS = 2;

const api = createBrowserApi();
api.state.loggedIn = true;
const projectId = api.state.project.id;
const [template] = api.state.runs;
let sequence = 9000;
const identifier = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const addRun = (changes) => {
  const run = {
    ...template,
    id: identifier(),
    status: 'finished',
    parameters: {},
    recordedParameters: {},
    tags: {},
    startedAt: '2026-10-08T00:00:00Z',
    endedAt: '2026-10-08T02:00:00Z',
    ...changes,
  };
  api.state.runs.push(run);
  return run;
};
// Replace the fixture Runs so the list shows only the Runs of this check.
api.state.runs.length = 0;
const trainingMetrics = { 'train/loss': 0.2, 'train/accuracy': 0.9, 'eval/loss': 0.3 };
const largeRun = addRun({ name: 'large-run', tags: { model: 'conformer' }, latestMetrics: trainingMetrics });
const secondRun = addRun({ name: 'second-run', tags: { model: 'conformer' }, latestMetrics: trainingMetrics });
const thirdRun = addRun({ name: 'third-run', tags: { model: 'transformer' }, latestMetrics: trainingMetrics });
const workerRun = addRun({
  name: 'worker-system-run',
  latestMetrics: {
    'system.cpu.percent': 40,
    'system.memory.used_bytes': 8e9,
    'system.gpu.0.utilization_percent': 70,
    'system.gpu.0.memory_used_bytes': 4e9,
  },
});
const mlflowRun = addRun({
  name: 'mlflow-system-run',
  latestMetrics: {
    'system/cpu_utilization_percentage': 35,
    'system/system_memory_usage_megabytes': 7000,
    'system/gpu_0_utilization_percentage': 65,
    'system/gpu_0_memory_usage_megabytes': 3500,
  },
});
const resumedRun = addRun({ name: 'resumed-run', tags: { model: 'transformer' }, latestMetrics: { 'train/loss': 0.4 } });
const RESUMED_AT_STEP = 500;
const resumeEvents = {
  items: [
    {
      id: identifier(),
      runId: resumedRun.id,
      resumedAt: '2026-10-08T01:00:00Z',
      previousStatus: 'failed',
      previousEndedAt: '2026-10-08T00:40:00Z',
      maxStepAtResume: RESUMED_AT_STEP - 1,
      source: 'native',
      actorUserId: null,
      reason: null,
    },
  ],
  segments: [
    { startedAt: '2026-10-08T00:00:00Z', endedAt: '2026-10-08T00:40:00Z', endStatus: 'failed', firstStep: null },
    { startedAt: '2026-10-08T01:00:00Z', endedAt: '2026-10-08T02:00:00Z', endStatus: 'finished', firstStep: RESUMED_AT_STEP },
  ],
};
const totalPointsOf = (runId) => (runId === largeRun.id ? LARGE_RUN_POINTS : 1000);
const seedOf = (runId) => Number.parseInt(runId.slice(-4), 10) % 7;

// A smooth curve per Run and key, sampled into at most maxPoints buckets like the API does.
function sampledSeries(runId, key, xAxis, maxPoints) {
  const total = totalPointsOf(runId);
  const buckets = Math.min(total, maxPoints);
  const perBucket = total / buckets;
  const offset = seedOf(runId) * 0.05 + (key.startsWith('eval/') ? 0.1 : 0);
  const value = (step) =>
    key.includes('accuracy') ? 1 - Math.exp(-step / 200) * 0.9 : Math.exp(-step / 300) + offset;
  // The resumed Run reaches RESUMED_AT_STEP when its second segment starts, an hour in.
  const stepSeconds = runId === resumedRun.id ? 3600 / RESUMED_AT_STEP : STEP_SECONDS;
  const xOf = (step) =>
    xAxis.kind === 'relative_time'
      ? step * stepSeconds
      : xAxis.kind === 'wall_time'
        ? Date.parse('2026-10-08T00:00:00Z') + step * stepSeconds * 1000
        : step;
  const points = Array.from({ length: buckets }, (_, index) => {
    const first = Math.floor(index * perBucket);
    const last = Math.max(first, Math.floor((index + 1) * perBucket) - 1);
    const values = [value(first), value(last)];
    return {
      x: xOf((first + last) / 2),
      step: last,
      value: (values[0] + values[1]) / 2,
      min: Math.min(...values),
      max: Math.max(...values),
      count: last - first + 1,
    };
  });
  return { runId, key, points, sampled: buckets < total, totalPoints: total, nanCount: 0, droppedPoints: 0 };
}

function groupsResponse(body) {
  const runs = body.runIds
    ? api.state.runs.filter((run) => body.runIds.includes(run.id))
    : api.state.runs.filter((run) => Object.keys(run.latestMetrics).some((key) => body.keys.includes(key)));
  const groups = new Map();
  for (const run of runs) {
    const groupKey =
      body.groupBy.kind === 'experiment' ? run.experimentId : (run.tags[body.groupBy.key] ?? '(none)');
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), run]);
  }
  return {
    groups: [...groups.entries()].map(([groupKey, members]) => ({
      groupKey,
      label: groupKey,
      runIds: members.map((run) => run.id),
      series: body.keys.map((key) => {
        const lines = members.map((run) => sampledSeries(run.id, key, body.xAxis, body.maxPoints ?? 1000).points);
        return {
          key,
          points: lines[0].map((point, index) => {
            const values = lines.map((line) => line[index].value);
            const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
            return { x: point.x, mean, min: Math.min(...values), max: Math.max(...values), stddev: 0, runCount: values.length };
          }),
        };
      }),
    })),
  };
}

const seriesRequests = [];
const groupRequests = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route(
  (url) => url.pathname.startsWith('/api/'),
  async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (payload) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname.endsWith('/metrics/series') && request.method() === 'POST') {
      const body = request.postDataJSON();
      seriesRequests.push(body);
      return reply({
        series: body.runIds.flatMap((runId) =>
          body.keys.map((key) =>
            api.state.runs.find((run) => run.id === runId)?.latestMetrics[key] === undefined
              ? { runId, key, points: [], sampled: false, totalPoints: 0, nanCount: 0, droppedPoints: 0 }
              : sampledSeries(runId, key, body.xAxis, body.maxPoints ?? 1000),
          ),
        ),
      });
    }
    if (url.pathname.endsWith('/metrics/groups') && request.method() === 'POST') {
      const body = request.postDataJSON();
      groupRequests.push(body);
      return reply(groupsResponse(body));
    }
    if (url.pathname.endsWith('/runs/compare') && request.method() === 'POST') {
      const body = request.postDataJSON();
      return reply({
        runs: body.runIds.map((runId) => api.state.runs.find((run) => run.id === runId)),
        baselineRunId: body.baselineRunId ?? null,
        datasetVersions: [],
        modelVersions: [],
        rows: [],
      });
    }
    const resume = url.pathname.match(/\/runs\/([^/]+)\/resume-events$/);
    if (resume)
      return reply(resume[1] === resumedRun.id ? resumeEvents : { items: [], segments: [] });
    return api.route(route);
  },
);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const projectBase = `${base}/projects/${projectId}`;

async function screenshot(name) {
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
}
async function setTheme(theme) {
  await page.evaluate((value) => localStorage.setItem('mmt.theme', value), theme);
  await page.reload();
}
const panels = () => page.locator('.chart-panel');
const panel = (title) => page.locator('.chart-panel', { has: page.getByRole('heading', { name: title, exact: true }) });
const panelTitles = () => page.locator('.chart-panel h3').allTextContents();
// Classes of metrics-chart-core-web's chart: one path per line and per band, one group per marker.
const LINE = '.chart-line';
const BAND = '.chart-band';
const MARKER = '.chart-marker';
const drawnLine = (scope) => scope.locator(LINE).first();
async function openPlacement(title) {
  await panel(title).locator('summary[aria-label="配置"]').click();
}

try {
  console.log('Browser check: first draw of a Run with 100,000 points per metric');
  const started = Date.now();
  await page.goto(`${projectBase}/runs/${largeRun.id}`);
  await drawnLine(panel('train/loss')).waitFor();
  const firstDrawMs = Date.now() - started;
  console.log(`  first chart drawn in ${firstDrawMs} ms`);
  assert.ok(firstDrawMs <= FIRST_DRAW_BUDGET_MS, `first draw took ${firstDrawMs} ms`);
  // Default layout: keys without a prefix, then eval/, then train/; one request for all panels.
  assert.deepEqual(await panelTitles(), ['eval/loss', 'train/accuracy', 'train/loss']);
  // React's development StrictMode may send the same request twice; the bodies must be one.
  assert.equal(new Set(seriesRequests.map((body) => JSON.stringify(body))).size, 1, 'all panels share one series request');
  assert.deepEqual(seriesRequests[0].keys.sort(), ['eval/loss', 'train/accuracy', 'train/loss']);
  await screenshot('run-detail-panels-light');

  console.log('Browser check: add, move and resize panels, kept after reload');
  await page.getByRole('button', { name: '図を追加' }).click();
  const editor = page.getByRole('dialog', { name: '図を追加' });
  await editor.getByLabel('タイトル').fill('loss比較');
  await editor.getByRole('checkbox', { name: 'eval/loss' }).check();
  await editor.getByRole('checkbox', { name: 'train/loss' }).check();
  await editor.getByRole('button', { name: '保存' }).click();
  await panel('loss比較').waitFor();
  assert.equal(await panels().count(), 4);
  await openPlacement('loss比較');
  await panel('loss比較').getByRole('button', { name: '全幅' }).click();
  await openPlacement('train/loss');
  await panel('train/loss').getByRole('button', { name: '左へ移動' }).click();
  const before = await panelTitles();
  await page.reload();
  await panel('loss比較').waitFor();
  assert.deepEqual(await panelTitles(), before, 'the arrangement survives a reload');
  const fullWidth = await panel('loss比較').evaluate((element) => element.parentElement.style.gridColumn);
  assert.match(fullWidth, /span 12/);

  console.log('Browser check: smoothing, log scale and x axis');
  await panel('train/loss').getByRole('button', { name: '図を設定' }).click();
  const settings = page.getByRole('dialog', { name: '図を設定' });
  await settings.getByRole('combobox', { name: /^平滑化/ }).selectOption('ema');
  await settings.getByLabel('y軸を対数').check();
  await settings.getByRole('combobox', { name: /^x軸/ }).first().selectOption('relative_time');
  await settings.getByRole('button', { name: '保存' }).click();
  await drawnLine(panel('train/loss')).waitFor();
  assert.ok(
    seriesRequests.some((body) => body.xAxis.kind === 'relative_time' && body.keys.includes('train/loss')),
    'the relative time axis is fetched',
  );
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    `mmt.chartPanels.v1:${projectId}:runDetail`,
  );
  const storedPanel = stored.panels.find((item) => item.metricKeys.join() === 'train/loss');
  assert.equal(storedPanel.smoothing.kind, 'ema');
  assert.equal(storedPanel.yScale, 'log');
  assert.equal(storedPanel.xAxis.kind, 'relative_time');

  console.log('Browser check: Compare overlays three Runs');
  seriesRequests.length = 0;
  await page.goto(`${base}/projects/${projectId}/compare?runs=${[largeRun.id, secondRun.id, thirdRun.id].join(',')}`);
  await drawnLine(panel('train/loss')).waitFor();
  assert.deepEqual(seriesRequests[0].runIds, [largeRun.id, secondRun.id, thirdRun.id]);
  assert.equal(await panel('train/loss').locator(LINE).count(), 3);
  await screenshot('compare-overlay-light');

  console.log('Browser check: Run list grouped by a tag draws means and bands');
  await page.goto(`${projectBase}/experiments`);
  await page.getByRole('button', { name: '図を表示' }).click();
  await drawnLine(panel('train/loss')).waitFor();
  await page.getByRole('combobox', { name: /^グループ化/ }).selectOption('tag');
  await page.getByLabel('グループ化するキー').fill('model');
  await page.locator('.chart-panel').first().locator(BAND).first().waitFor();
  const grouped = groupRequests.at(-1);
  assert.deepEqual(grouped.groupBy, { kind: 'tag', key: 'model' });
  assert.ok(grouped.search && !('limit' in grouped.search), 'the search is sent as is');
  assert.equal(await panel('train/loss').locator(LINE).count(), 2, 'one line per group');
  await screenshot('run-list-grouped-light');

  console.log('Browser check: system metrics of worker and MLflow names share categories');
  const systemTitles = [];
  for (const run of [workerRun, mlflowRun]) {
    await page.goto(`${projectBase}/runs/${run.id}?tab=systemMetrics`);
    await drawnLine(panel('CPU（%）')).waitFor();
    systemTitles.push(await panelTitles());
  }
  assert.deepEqual(systemTitles[0], ['CPU（%）', 'メモリ（bytes）', 'GPU 0（%）', 'GPU 0（bytes）']);
  assert.deepEqual(systemTitles[1], systemTitles[0]);
  await screenshot('system-metrics-mlflow-light');

  console.log('Browser check: resumed Run shows its segments and the boundary');
  await page.goto(`${projectBase}/runs/${resumedRun.id}`);
  await page.getByRole('region', { name: '実行区間' }).waitFor();
  assert.equal(await page.locator('.resume-band').count(), 2);
  await page.getByRole('cell', { name: '再開 1' }).waitFor();
  await panel('train/loss').locator(MARKER).first().waitFor({ state: 'attached' });
  await screenshot('resumed-run-light');

  console.log('Browser check: dark theme screenshots');
  await setTheme('dark');
  await drawnLine(panel('train/loss')).waitFor();
  await screenshot('resumed-run-dark');
  await page.goto(`${projectBase}/runs/${largeRun.id}`);
  await drawnLine(panel('loss比較')).waitFor();
  await screenshot('run-detail-panels-dark');
  await page.goto(`${projectBase}/experiments?charts=1`);
  await drawnLine(panel('train/loss')).waitFor();
  await screenshot('run-list-grouped-dark');
  await setTheme('light');

  console.log('Browser check: a viewer can still arrange and change charts');
  api.state.project.role = 'viewer';
  api.state.user.isAdmin = false;
  await page.goto(`${projectBase}/runs/${secondRun.id}`);
  await drawnLine(panel('train/loss')).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Runを編集' }).count(), 0, 'viewer cannot edit the Run');
  await openPlacement('train/loss');
  await panel('train/loss').getByRole('button', { name: '幅 1/2' }).click();
  await panel('train/loss').getByRole('button', { name: '図を設定' }).click();
  await page.getByRole('dialog', { name: '図を設定' }).getByLabel('y軸を対数').uncheck();
  await page.getByRole('dialog', { name: '図を設定' }).getByRole('button', { name: '保存' }).click();
  const viewerWidth = await panel('train/loss').evaluate((element) => element.parentElement.style.gridColumn);
  assert.match(viewerWidth, /span 6/);

  assert.deepEqual(pageErrors, []);
  console.log('Browser check: chart panels passed');
} finally {
  await browser.close();
}
