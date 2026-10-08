// Browser check for the Run analysis panel (parallel coordinates, parameter importance, scatter
// plot) on tests/fixtures/analysis-harness.html with a mocked API: brushing narrows the selection
// handed to the Run list, the importance table sorts, a scatter point opens the Run, a sweep uses
// its objective, and 5000 Runs stay responsive while dragging.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

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
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const SMALL_RUN_COUNT = 300;
const LARGE_RUN_COUNT = 5000;
// The brief's target for one drag step at 5000 Runs, including the Playwright round trip.
const DRAG_STEP_BUDGET_MS = 200;
const DRAG_STEPS = 12;

// Deterministic pseudo-random numbers so every run of the check sees the same Runs.
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function syntheticRuns(count) {
  const next = random(count);
  const optimizers = ['adam', 'adamw', 'sgd'];
  return Array.from({ length: count }, (_, index) => {
    const lr = 10 ** (-5 + 4 * next());
    const batchSize = [16, 32, 64][index % 3];
    const optimizer = optimizers[Math.floor(next() * optimizers.length)];
    const dropout = Number((next() * 0.5).toFixed(3));
    const loss = Math.abs(Math.log10(lr) + 3) * 0.3 + (optimizer === 'sgd' ? 0.4 : 0) + next() * 0.1;
    return {
      runId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `trial-${String(index).padStart(4, '0')}`,
      experimentId: 'experiment',
      status: 'finished',
      // Every 7th Run lacks dropout so the missing band is exercised.
      params: { lr, batch_size: batchSize, optimizer, ...(index % 7 === 0 ? {} : { dropout }) },
      metrics: { loss, accuracy: 1 - loss / 2 },
      objective: index % 11 === 0 ? null : loss,
      sweepTrialIndex: index,
    };
  });
}

const runSets = {
  'exp-300': syntheticRuns(SMALL_RUN_COUNT),
  'exp-5000': syntheticRuns(LARGE_RUN_COUNT),
  'sweep-300': syntheticRuns(SMALL_RUN_COUNT),
};

function runsOf(body) {
  if (body.runSet.sweepId) return runSets[body.runSet.sweepId];
  return runSets[body.runSet.search.experimentIds[0]];
}

function analysisTable(body) {
  const runs = runsOf(body);
  const isSweep = Boolean(body.runSet.sweepId);
  const paramKeys = ['batch_size', 'dropout', 'lr', 'optimizer'];
  const coverage = (key) => runs.filter((run) => key in run.params).length / runs.length;
  const range = (values) => ({ min: Math.min(...values), max: Math.max(...values) });
  return {
    runs: runs.map((run) => ({
      runId: run.runId,
      name: run.name,
      experimentId: run.experimentId,
      status: run.status,
      params: run.params,
      metrics: Object.fromEntries(body.metrics.filter((key) => key in run.metrics).map((key) => [key, run.metrics[key]])),
      ...(isSweep ? { sweepTrialIndex: run.sweepTrialIndex, objective: run.objective } : {}),
    })),
    params: paramKeys.map((key) =>
      key === 'optimizer'
        ? { key, kind: 'categorical', values: ['adam', 'adamw', 'sgd'], coverage: coverage(key) }
        : { key, kind: 'numeric', coverage: coverage(key) },
    ),
    metrics: body.metrics.map((key) => ({ key, ...range(runs.map((run) => run.metrics[key])) })),
    ...(isSweep
      ? { objective: { metric: 'loss', goal: 'minimize', aggregation: 'last', ...range(runs.map((run) => run.metrics.loss)) } }
      : {}),
  };
}

function parameterImportance(body) {
  const runs = runsOf(body);
  return {
    targetMetric: body.targetMetric ?? 'loss',
    targetSource: body.targetMetric ? 'latest_metric' : 'sweep_objective',
    runCount: runs.length,
    skippedRunCount: 0,
    entries: [
      { param: 'lr', kind: 'numeric', correlation: -0.62, importance: 0.55, permutationImportance: 0.4, coverage: 1 },
      { param: 'optimizer', kind: 'categorical', correlation: null, importance: 0.3, permutationImportance: 0.35, coverage: 1 },
      { param: 'dropout', kind: 'numeric', correlation: 0.05, importance: 0.1, permutationImportance: 0.01, coverage: 0.86 },
      { param: 'batch_size', kind: 'numeric', correlation: 0.02, importance: 0.05, permutationImportance: 0.02, coverage: 1 },
    ],
    excluded: [{ param: 'seed_label', reason: 'high_cardinality' }],
    importanceUnavailableReason: null,
    outOfBagR2: 0.81,
  };
}

const apiRequests = [];
async function routeApi(page) {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      apiRequests.push(`${request.method()} ${url.pathname}`);
      const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      if (url.pathname.endsWith('/runs/analysis/table')) return json(analysisTable(body));
      if (url.pathname.endsWith('/runs/analysis/parameter-importance')) return json(parameterImportance(body));
      if (url.pathname.endsWith('/runs/search'))
        return json({ items: [{ latestMetrics: { loss: 1, accuracy: 0.5 } }], nextCursor: null });
      if (url.pathname.endsWith('/sweeps/sweep-300'))
        return json({ id: 'sweep-300', objective: { metric: 'loss', goal: 'minimize', aggregation: 'last' } });
      if (url.pathname.endsWith('/sweeps/sweep-300/trials'))
        return json({ items: runSets['sweep-300'].slice(0, 50).map((run) => ({ runId: run.runId })), nextCursor: null });
      if (url.pathname.endsWith('/runs/compare'))
        return json({ runs: [], rows: [{ namespace: 'metrics', key: 'accuracy' }, { namespace: 'metrics', key: 'loss' }] });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not mocked","code":"not_found"}' });
    },
  );
}

async function openHarness(query) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routeApi(page);
  await page.goto(`${base}/tests/fixtures/analysis-harness.html?${query}`);
  return { context, page, errors };
}

async function screenshot(page, name) {
  if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/${name}.png`, fullPage: true });
}

async function selectionCount(page) {
  const textContent = await page.getByTestId('parallel-selection-count').textContent();
  const match = textContent.match(/(\d+) 件中 (\d+) 件/);
  return { total: Number(match[1]), selected: Number(match[2]) };
}

async function dragOnAxis(page, axisKey, fromShare, toShare) {
  const box = await page.getByTestId(`parallel-axis-${axisKey}`).boundingBox();
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height * fromShare);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height * toShare, { steps: 5 });
  await page.mouse.up();
}

const results = {};
try {
  // 300 Runs: brushing, Run list selection, importance sorting and scatter navigation.
  {
    const { context, page, errors } = await openHarness('experimentId=exp-300');
    await page.getByTestId('parallel-selection-count').waitFor();
    assert.deepEqual(await selectionCount(page), { total: SMALL_RUN_COUNT, selected: SMALL_RUN_COUNT });
    // Default axes follow importance: lr, optimizer, dropout, batch_size, then the target metric.
    const axisKeys = await page.locator('.parallel-axis').evaluateAll((nodes) => nodes.map((node) => node.dataset.axisKey));
    assert.deepEqual(axisKeys, ['params.lr', 'params.optimizer', 'params.dropout', 'params.batch_size', 'metrics.accuracy']);
    await screenshot(page, '01-parallel-300');

    await dragOnAxis(page, 'params.lr', 0.1, 0.45);
    const brushed = await selectionCount(page);
    assert.ok(brushed.selected > 0 && brushed.selected < SMALL_RUN_COUNT, `brush kept ${brushed.selected}`);
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="run-list-selection"]')?.dataset.count === String(expected),
      brushed.selected,
    );
    await dragOnAxis(page, 'metrics.accuracy', 0.5, 1.0);
    const twoBrushes = await selectionCount(page);
    assert.ok(twoBrushes.selected > 0 && twoBrushes.selected <= brushed.selected, `second brush kept ${twoBrushes.selected}`);
    await page.getByTestId('analysis-selected-runs').waitFor();
    await screenshot(page, '02-parallel-brushed');
    results.brushing = { afterFirstBrush: brushed.selected, afterSecondBrush: twoBrushes.selected };

    // Moving an axis keeps its brush; a click on an axis clears its brush.
    await page.getByRole('button', { name: 'lr: 右へ移動' }).click();
    const movedKeys = await page.locator('.parallel-axis').evaluateAll((nodes) => nodes.map((node) => node.dataset.axisKey));
    assert.equal(movedKeys[1], 'params.lr');
    assert.equal((await selectionCount(page)).selected, twoBrushes.selected);
    await page.getByRole('button', { name: '絞り込みを解除' }).click();
    assert.equal((await selectionCount(page)).selected, SMALL_RUN_COUNT);
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="run-list-selection"]')?.dataset.count === String(expected),
      SMALL_RUN_COUNT,
    );

    // Log scale on lr (every value is positive) relabels the ticks in powers of ten.
    await page.getByRole('checkbox', { name: 'lr: 対数' }).check();
    const ticks = await page.locator('[data-axis-key="params.lr"] .parallel-axis-tick').allTextContents();
    assert.ok(ticks.some((tick) => tick.includes('e-')), `log ticks ${ticks.join(',')}`);

    await page.getByRole('tab', { name: 'パラメータ重要度' }).click();
    await page.locator('.importance-table tbody tr').first().waitFor();
    const paramOrder = () => page.locator('.importance-table tbody tr').evaluateAll((rows) => rows.map((row) => row.dataset.param));
    assert.deepEqual(await paramOrder(), ['lr', 'optimizer', 'dropout', 'batch_size']);
    await page.getByRole('button', { name: 'Coverage', exact: true }).click();
    assert.equal((await paramOrder()).at(-1), 'dropout', 'descending coverage puts the partly covered param last');
    await page.getByRole('button', { name: 'Param', exact: true }).click();
    assert.deepEqual(await paramOrder(), ['batch_size', 'dropout', 'lr', 'optimizer']);
    await page.getByRole('radio', { name: 'Permutation' }).check();
    await page.getByRole('button', { name: '重要度', exact: true }).click();
    assert.deepEqual(await paramOrder(), ['lr', 'optimizer', 'batch_size', 'dropout']);
    await page.getByText('計算から除いたparam (1)').waitFor();
    await screenshot(page, '03-importance-sorted');

    await page.getByRole('tab', { name: '散布図' }).click();
    await page.locator('.scatter-point').first().waitFor();
    assert.equal(await page.locator('.scatter-point').count(), SMALL_RUN_COUNT);
    await screenshot(page, '04-scatter');
    const point = page.locator('.scatter-point').nth(10);
    const clickedRunId = await point.getAttribute('data-run-id');
    await point.click({ force: true });
    assert.equal(await page.getByTestId('run-detail').textContent(), clickedRunId);
    results.scatterOpenedRun = clickedRunId;

    // Only read endpoints: the panel works for viewers (the API allows viewer for all of them).
    const writes = apiRequests.filter((line) => !/(\/runs\/analysis\/|\/runs\/search|\/runs\/compare|^GET )/.test(line));
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Sweep: the objective is the default target and gets its own axis.
  {
    const { context, page, errors } = await openHarness('sweepId=sweep-300');
    await page.getByTestId('parallel-selection-count').waitFor();
    assert.match(await page.getByLabel('目的metric').inputValue(), /^$/);
    const axisKeys = await page.locator('.parallel-axis').evaluateAll((nodes) => nodes.map((node) => node.dataset.axisKey));
    assert.equal(axisKeys.at(-1), 'objective');
    await page.getByRole('tab', { name: 'パラメータ重要度' }).click();
    await page.getByText('Sweep試行の集約済みobjective').waitFor();
    await screenshot(page, '05-sweep-importance');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 5000 Runs: lines go to the canvas and each drag step answers within the budget.
  {
    const { context, page, errors } = await openHarness('experimentId=exp-5000&theme=dark');
    await page.getByTestId('parallel-selection-count').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('.parallel-chart-canvas').count(), 1);
    const box = await page.getByTestId('parallel-axis-params.lr').boundingBox();
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height * 0.1);
    await page.mouse.down();
    const stepTimes = [];
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      const started = Date.now();
      await page.mouse.move(x, box.y + box.height * (0.1 + step * 0.04));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      stepTimes.push(Date.now() - started);
    }
    await page.mouse.up();
    const brushed = await selectionCount(page);
    assert.ok(brushed.selected > 0 && brushed.selected < LARGE_RUN_COUNT);
    const slowest = Math.max(...stepTimes);
    results.largeDrag = { runs: LARGE_RUN_COUNT, stepTimesMs: stepTimes, slowestMs: slowest, selected: brushed.selected };
    assert.ok(slowest <= DRAG_STEP_BUDGET_MS, `slowest drag step ${slowest}ms`);
    await screenshot(page, '06-parallel-5000-dark');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
} finally {
  await browser.close();
}
