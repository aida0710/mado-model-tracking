import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExperimentTask, Job, Run, Sweep, SweepPage, WorkerJob } from '@mmt/contracts';
import {
  createHarness,
  entity,
  login,
  request,
  testDatabaseUrl,
  type Harness,
} from './harness.js';
import { projectFixture } from './fixtures.js';
import { sweepFixture } from './sweepFixtures.js';

const GRID_SPACE = { lr: { values: [0.1, 0.01] }, batch: { values: [16, 32] } };

describe.skipIf(!testDatabaseUrl)('Sweep（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function runOf(fixture: { basePath: string; viewer: { cookie: string } }, runId: string) {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  it('grid 2×2をparallelism=2で回すと、同時に2件までqueuedになり、1件の終端で次が入り、全終端でfinishedになる', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'grid',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 10,
      parallelism: 2,
    });
    expect(sweep).toMatchObject({
      status: 'running',
      taskRevision: fixture.task.revision,
      experimentId: fixture.experiment.id,
      objective: { metric: 'loss', goal: 'minimize', aggregation: 'last' },
      trialCounts: { total: 2, queued: 2 },
      bestTrial: null,
    });
    expect(Number.isInteger(sweep.seed)).toBe(true);

    let trials = await fixture.listTrials(sweep.id);
    expect(trials.map((trial) => trial.parameters)).toEqual([
      { batch: 16, lr: 0.1 },
      { batch: 16, lr: 0.01 },
    ]);
    const firstRun = await runOf(fixture, trials[0]!.runId);
    expect(firstRun).toMatchObject({
      name: 'grid-0',
      taskId: fixture.task.id,
      taskRevision: fixture.task.revision,
      parameters: { epochs: 2, seed: 42, batch: 16, lr: 0.1 },
      tags: { task: 'fixture', 'mmt.sweepId': sweep.id, 'mmt.sweepTrialIndex': '0' },
      createdBy: fixture.editor.userId,
    });

    const claimed = await fixture.claimAll();
    expect(claimed).toHaveLength(2);
    expect((await fixture.getSweep(sweep.id)).trialCounts).toMatchObject({ running: 2, queued: 0 });
    const losses = [0.5, 0.2, 0.9, 0.4];
    const byRun = (item: WorkerJob) => trials.find((trial) => trial.runId === item.run.id)!;
    for (const item of claimed)
      await fixture.logMetric(item, [
        { name: 'loss', value: 1, step: 0 },
        { name: 'loss', value: losses[byRun(item).trialIndex]!, step: 1 },
      ]);
    await fixture.complete(claimed[0]!);

    trials = await fixture.listTrials(sweep.id);
    expect(trials).toHaveLength(3);
    expect(trials.filter((trial) => ['queued', 'running'].includes(trial.state))).toHaveLength(2);
    const ended = trials.find((trial) => trial.runId === claimed[0]!.run.id)!;
    expect(ended).toMatchObject({ state: 'finished', objectiveStep: 1 });
    expect(ended.objectiveValue).toBe(losses[ended.trialIndex]);

    await fixture.complete(claimed[1]!);
    const rest = await fixture.claimAll();
    expect(rest).toHaveLength(2);
    trials = await fixture.listTrials(sweep.id);
    for (const item of rest)
      await fixture.logMetric(item, [
        { name: 'loss', value: losses[byRun(item).trialIndex]!, step: 3 },
      ]);
    for (const item of rest) await fixture.complete(item);

    const finished = await fixture.getSweep(sweep.id);
    expect(finished).toMatchObject({
      status: 'finished',
      statusReason: 'search_space_exhausted',
      trialCounts: { total: 4, finished: 4 },
      bestTrial: { trialIndex: 1, objectiveValue: 0.2, parameters: { batch: 16, lr: 0.01 } },
    });
    expect(finished.finishedAt).not.toBeNull();
    const ordered = await fixture.listTrials(sweep.id, '?orderBy=objective&limit=2');
    expect(ordered.map((trial) => trial.trialIndex)).toEqual([1, 3]);
    const page = await entity<{ items: { trialIndex: number }[]; nextCursor: string }>(
      await request(
        harness.app,
        `${fixture.sweepsPath}/${sweep.id}/trials?orderBy=objective&limit=2&cursor=${ordered[1]!.id}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(page.items.map((trial) => trial.trialIndex)).toEqual([0, 2]);
  });

  it('randomはmax_trialsで投入を止め、maximizeでは値の大きい試行が最良になる', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'random',
      method: 'random',
      searchSpace: { lr: { distribution: 'log_uniform', min: 0.0001, max: 0.1 } },
      objective: { metric: 'accuracy', goal: 'maximize', aggregation: 'max' },
      maxTrials: 3,
      parallelism: 5,
      seed: 7,
    });
    expect(sweep.trialCounts.total).toBe(3);
    const claimed = await fixture.claimAll();
    const accuracies = [0.7, 0.9, 0.8];
    for (const [index, item] of claimed.entries()) {
      await fixture.logMetric(item, [
        { name: 'accuracy', value: accuracies[index]!, step: 1 },
        { name: 'accuracy', value: 0.1, step: 2 },
      ]);
      await fixture.complete(item);
    }
    const finished = await fixture.getSweep(sweep.id);
    expect(finished).toMatchObject({
      status: 'finished',
      statusReason: 'max_trials_reached',
      trialCounts: { total: 3, finished: 3 },
      bestTrial: { objectiveValue: 0.9, objectiveStep: 1, runId: claimed[1]!.run.id },
    });
    const trials = await fixture.listTrials(sweep.id);
    expect(new Set(trials.map((trial) => trial.parameters.lr)).size).toBe(3);
  });

  it('pauseで投入が止まり、resumeで再開する。作成者以外のeditorは操作できない', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'pause',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
      parallelism: 1,
    });
    const otherEditor = await login(harness, 'other-editor@localhost');
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${otherEditor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'editor' },
      }),
      200,
    );
    const forbidden = await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/pause`, {
      method: 'POST',
      cookie: otherEditor.cookie,
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('sweep_owner_required');
    const paused = await entity<Sweep>(
      await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/pause`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(paused).toMatchObject({ status: 'paused', statusReason: 'user_requested' });
    const [first] = await fixture.claimAll();
    await fixture.complete(first!);
    expect((await fixture.getSweep(sweep.id)).trialCounts).toMatchObject({ total: 1, finished: 1 });

    // Project admin may operate on another member's sweep.
    const resumed = await entity<Sweep>(
      await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/resume`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(resumed).toMatchObject({ status: 'running', statusReason: null });
    expect(resumed.trialCounts).toMatchObject({ total: 2, queued: 1 });
  });

  it('cancel(cancelRunningTrials)でqueuedはcanceled、実行中はcancel_requestedになり、Sweepはcanceledになる', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'cancel',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
      parallelism: 2,
    });
    const running = await fixture.claim();
    const canceled = await entity<Sweep>(
      await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { cancelRunningTrials: true },
      }),
      200,
    );
    expect(canceled).toMatchObject({ status: 'canceled', statusReason: 'user_requested' });
    const trials = await fixture.listTrials(sweep.id);
    expect(trials).toHaveLength(2);
    const runningTrial = trials.find((trial) => trial.runId === running!.run.id)!;
    expect(runningTrial).toMatchObject({ state: 'running', jobCancelRequested: true });
    const queuedTrial = trials.find((trial) => trial.runId !== running!.run.id)!;
    expect(queuedTrial).toMatchObject({ state: 'canceled', runStatus: 'canceled' });

    // The worker reports the canceled process; no new trial starts after cancellation.
    await fixture.complete(running!, 'canceled');
    const after = await fixture.getSweep(sweep.id);
    expect(after.trialCounts).toMatchObject({ total: 2, canceled: 2 });
    const again = await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/resume`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
    });
    expect(again.status).toBe(409);
  });

  it('cancelRunningTrials=falseでは実行中の試行を続け、queuedだけを止める', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'cancel-queued',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
      parallelism: 2,
    });
    const running = await fixture.claim();
    await entity(
      await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {},
      }),
      200,
    );
    const job = (await fixture.listTrials(sweep.id)).find(
      (trial) => trial.runId === running!.run.id,
    )!;
    expect(job).toMatchObject({ state: 'running', jobCancelRequested: false });
  });

  it('Taskが改訂されるとpaused(task_revision_changed)になり、resumeは409になる', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'revision',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
      parallelism: 1,
    });
    await entity<ExperimentTask>(
      await request(harness.app, fixture.taskPath, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: fixture.task.revision, parameters: { epochs: 5 } },
      }),
      200,
    );
    const [first] = await fixture.claimAll();
    await fixture.complete(first!);
    expect(await fixture.getSweep(sweep.id)).toMatchObject({
      status: 'paused',
      statusReason: 'task_revision_changed',
      trialCounts: { total: 1 },
    });
    const resumed = await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/resume`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
    });
    expect(resumed.status).toBe(409);
    expect((await resumed.json()).code).toBe('task_revision_changed');
  });

  it('作成者をviewerに下げると、次の投入でpaused(owner_forbidden)になる', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'owner',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
      parallelism: 1,
    });
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'viewer' },
      }),
      200,
    );
    const [first] = await fixture.claimAll();
    await fixture.complete(first!);
    expect(await fixture.getSweep(sweep.id)).toMatchObject({
      status: 'paused',
      statusReason: 'owner_forbidden',
      trialCounts: { total: 1, finished: 1 },
    });
  });

  it('PATCHで並列数を増やすと空いた枠に投入し、作成済みより小さいmaxTrialsは422になる', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'patch',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
      parallelism: 1,
    });
    const widened = await entity<Sweep>(
      await request(harness.app, `${fixture.sweepsPath}/${sweep.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { parallelism: 3 },
      }),
      200,
    );
    expect(widened).toMatchObject({ parallelism: 3, trialCounts: { total: 3, queued: 3 } });
    const tooSmall = await request(harness.app, `${fixture.sweepsPath}/${sweep.id}`, {
      method: 'PATCH',
      cookie: fixture.editor.cookie,
      body: { maxTrials: 2 },
    });
    expect(tooSmall.status).toBe(422);
    expect((await tooSmall.json()).code).toBe('sweep_max_trials_below_created');
  });

  it('viewerの作成は403、他ProjectのTaskは404、探索空間の不正は422', async () => {
    const fixture = await sweepFixture(harness);
    const body = {
      name: 'invalid',
      taskId: fixture.task.id,
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
    };
    const asViewer = await request(harness.app, fixture.sweepsPath, {
      method: 'POST',
      cookie: fixture.viewer.cookie,
      body,
    });
    expect(asViewer.status).toBe(403);

    const other = await projectFixture(harness);
    const otherTask = await request(harness.app, `${other.basePath}/sweeps`, {
      method: 'POST',
      cookie: fixture.administrator.cookie,
      body,
    });
    expect(otherTask.status).toBe(404);
    const unknownTask = await request(harness.app, fixture.sweepsPath, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { ...body, taskId: randomUUID() },
    });
    expect(unknownTask.status).toBe(404);

    for (const [searchSpace, method] of [
      [{ lr: { distribution: 'uniform', min: 0, max: 1 } }, 'grid'],
      [{ lr: { values: [] } }, 'random'],
      [{ lr: { distribution: 'uniform', min: 1, max: 0 } }, 'bayes'],
      [{}, 'random'],
    ] as const) {
      const response = await request(harness.app, fixture.sweepsPath, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { ...body, searchSpace, method },
      });
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('sweep_space_invalid');
    }
    const badEarlyStopping = await request(harness.app, fixture.sweepsPath, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { ...body, earlyStopping: { type: 'hyperband', minIter: 1, eta: 1 } },
    });
    expect(badEarlyStopping.status).toBe(422);
    for (const limits of [{ maxTrials: 0 }, { maxTrials: 10001 }, { parallelism: 101 }]) {
      const response = await request(harness.app, fixture.sweepsPath, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { ...body, ...limits },
      });
      expect(response.status).toBe(422);
    }
    expect((await harness.database.query('SELECT id FROM sweeps')).rows).toHaveLength(0);
  });

  it('Sweepの定義と試行のparametersは更新できず、操作は監査ログに残る', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'immutable',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
      parallelism: 1,
    });
    for (const statement of [
      `UPDATE sweeps SET search_space='{}'::jsonb WHERE id=$1`,
      `UPDATE sweeps SET method='random' WHERE id=$1`,
      `UPDATE sweeps SET objective='{"metric":"acc","goal":"maximize","aggregation":"last"}'::jsonb WHERE id=$1`,
      'UPDATE sweeps SET task_revision=task_revision+1 WHERE id=$1',
      `UPDATE sweep_trials SET parameters='{}'::jsonb WHERE sweep_id=$1`,
    ])
      await expect(harness.database.query(statement, [sweep.id])).rejects.toMatchObject({
        code: '23514',
      });

    await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/pause`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
    });
    await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/resume`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
    });
    await request(harness.app, `${fixture.sweepsPath}/${sweep.id}`, {
      method: 'PATCH',
      cookie: fixture.editor.cookie,
      body: { maxTrials: 3 },
    });
    await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/cancel`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { cancelRunningTrials: true },
    });
    await request(harness.app, `${fixture.sweepsPath}/${sweep.id}/pause`, {
      method: 'POST',
      cookie: fixture.viewer.cookie,
    });
    const audit = await harness.database.query(
      `SELECT action,outcome,actor_user_id FROM audit_events WHERE resource_type='sweep' AND resource_id=$1
      ORDER BY occurred_at,id`,
      [sweep.id],
    );
    expect(audit.rows.map((row) => [row.action, row.outcome])).toEqual([
      ['sweep.create', 'success'],
      ['sweep.pause', 'success'],
      ['sweep.resume', 'success'],
      ['sweep.update', 'success'],
      ['sweep.cancel', 'success'],
      ['sweep.pause', 'denied'],
    ]);
  });

  it('一覧はstatusで絞り込め、cursorで続きを取得できる', async () => {
    const fixture = await sweepFixture(harness);
    const created: Sweep[] = [];
    for (const name of ['first', 'second', 'third'])
      created.push(
        await fixture.createSweep({
          name,
          method: 'random',
          searchSpace: { lr: { values: [1, 2] } },
          objective: { metric: 'loss', goal: 'minimize' },
          maxTrials: 1,
        }),
      );
    await request(harness.app, `${fixture.sweepsPath}/${created[0]!.id}/pause`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
    });
    const firstPage = await entity<SweepPage>(
      await request(harness.app, `${fixture.sweepsPath}?limit=2`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(firstPage.items.map((sweep) => sweep.name)).toEqual(['third', 'second']);
    const secondPage = await entity<SweepPage>(
      await request(harness.app, `${fixture.sweepsPath}?limit=2&cursor=${firstPage.nextCursor}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(secondPage).toMatchObject({ items: [{ name: 'first' }], nextCursor: null });
    const paused = await entity<SweepPage>(
      await request(harness.app, `${fixture.sweepsPath}?status=paused`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(paused.items.map((sweep) => sweep.id)).toEqual([created[0]!.id]);
  });

  it('scheduler は終端を取りこぼした試行を記録し直して次を投入する', async () => {
    const fixture = await sweepFixture(harness);
    const sweep = await fixture.createSweep({
      name: 'recover',
      method: 'grid',
      searchSpace: GRID_SPACE,
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 4,
      parallelism: 1,
    });
    const [trial] = await fixture.listTrials(sweep.id);
    // Simulate a terminal transition whose handler did not run (e.g. it failed and rolled back).
    await harness.database.query(
      "UPDATE jobs SET status='failed',ended_at=now() WHERE id=$1",
      [trial!.jobId],
    );
    await harness.database.query("UPDATE runs SET status='failed',ended_at=now() WHERE id=$1", [
      trial!.runId,
    ]);
    await harness.sweepScheduler.tickAll();
    const trials = await fixture.listTrials(sweep.id);
    expect(trials.map((item) => item.state)).toEqual(['failed', 'queued']);
  });

  it('ジョブ一覧のcancel APIの動作は切り出し後も変わらない', async () => {
    const fixture = await sweepFixture(harness);
    const run = await fixture.newRun('Direct cancel');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const canceled = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(canceled).toMatchObject({ status: 'canceled', cancelRequested: true });
    expect((await runOf(fixture, run.id)).status).toBe('canceled');
    const forbidden = await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
      method: 'POST',
      cookie: fixture.viewer.cookie,
    });
    expect(forbidden.status).toBe(403);
  });
});
