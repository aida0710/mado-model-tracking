import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job, Project, WorkerJob, WorkerPresence } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

describe.skipIf(!testDatabaseUrl)('workerの在籍登録とheartbeat途絶（独立PostgreSQL）', () => {
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

  async function claim(token: string, body: Record<string, unknown>) {
    return entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token,
        body,
      }),
      200,
    );
  }

  async function lastSeenAt(workerId: string): Promise<Date> {
    const result = await harness.database.query(
      'SELECT last_seen_at FROM workers WHERE worker_id=$1',
      [workerId],
    );
    return result.rows[0].last_seen_at as Date;
  }

  async function listWorkers(path: string, cookie: string): Promise<WorkerPresence[]> {
    return (
      await entity<{ items: WorkerPresence[] }>(await request(harness.app, path, { cookie }), 200)
    ).items;
  }

  it('claimでworkerが登録され、15秒以内の連続claimでは最終応答を書き換えない', async () => {
    const fixture = await executionFixture(harness);
    const workerInfo = {
      version: '0.1.0',
      hostname: 'gpu-host-1',
      parallelJobs: 2,
    };
    await claim(fixture.workerToken, { workerId: 'host-1', workerInfo });
    const firstSeen = await lastSeenAt('host-1');
    await claim(fixture.workerToken, { workerId: 'host-1', workerInfo });
    expect(await lastSeenAt('host-1')).toEqual(firstSeen);

    // Age the row past the write interval instead of waiting in real time.
    await harness.database.query(
      "UPDATE workers SET last_seen_at=now()-interval '16 seconds' WHERE worker_id='host-1'",
    );
    const aged = await lastSeenAt('host-1');
    await claim(fixture.workerToken, { workerId: 'host-1' });
    expect((await lastSeenAt('host-1')).getTime()).toBeGreaterThan(aged.getTime());

    const [worker] = await listWorkers(`${fixture.basePath}/workers`, fixture.viewer.cookie);
    expect(worker).toMatchObject({
      projectId: fixture.project.id,
      workerId: 'host-1',
      tokenName: 'Test Worker',
      // Fields omitted by a later claim keep the reported values.
      version: '0.1.0',
      hostname: 'gpu-host-1',
      parallelJobs: 2,
      targetIds: null,
      status: 'online',
      activeJobCount: 0,
    });
  });

  it('作業内容が変わったclaimは間隔内でも記録し、120秒途絶したworkerはofflineになる', async () => {
    const fixture = await executionFixture(harness);
    await claim(fixture.workerToken, { workerId: 'host-1' });
    await claim(fixture.workerToken, {
      workerId: 'host-1',
      targetIds: [fixture.target.id],
      workerInfo: { version: '0.2.0' },
    });
    let [worker] = await listWorkers(`${fixture.basePath}/workers`, fixture.viewer.cookie);
    expect(worker).toMatchObject({
      targetIds: [fixture.target.id],
      version: '0.2.0',
    });

    await harness.database.query("UPDATE workers SET last_seen_at=now()-interval '121 seconds'");
    [worker] = await listWorkers(`${fixture.basePath}/workers`, fixture.viewer.cookie);
    expect(worker!.status).toBe('offline');

    // Coming back restarts the displayed uptime.
    await harness.database.query("UPDATE workers SET started_at=now()-interval '1 day'");
    await request(harness.app, '/api/worker/resume', {
      method: 'POST',
      token: fixture.workerToken,
      body: { workerId: 'host-1' },
    });
    [worker] = await listWorkers(`${fixture.basePath}/workers`, fixture.viewer.cookie);
    expect(worker!.status).toBe('online');
    expect(Date.now() - new Date(worker!.startedAt).getTime()).toBeLessThan(60_000);
  });

  it('heartbeatが60秒途絶したJobはheartbeatStaleになるが、状態とGPU予約は変えない', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun();
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    const claimed = (await claim(fixture.workerToken, { workerId: 'host-1' })).item!;
    expect(claimed.job.heartbeatStale).toBe(false);
    const heartbeat = await request(harness.app, `/api/worker/jobs/${claimed.job.id}/heartbeat`, {
      method: 'POST',
      token: fixture.workerToken,
      body: { leaseId: claimed.job.leaseId, status: 'running' },
    });
    expect(heartbeat.status).toBe(200);

    await harness.database.query(
      "UPDATE jobs SET heartbeat_at=now()-interval '61 seconds' WHERE id=$1",
      [claimed.job.id],
    );
    const jobs = (
      await entity<{ items: Job[] }>(
        await request(harness.app, `${fixture.basePath}/jobs`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      )
    ).items;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: claimed.job.id,
      status: 'running',
      heartbeatStale: true,
    });
    const reservations = await harness.database.query(
      'SELECT gpu_id FROM gpu_reservations WHERE job_id=$1',
      [claimed.job.id],
    );
    expect(reservations.rows).toEqual([{ gpu_id: '0' }]);

    const [worker] = await listWorkers(`${fixture.basePath}/workers`, fixture.viewer.cookie);
    expect(worker!.activeJobCount).toBe(1);
  });

  it('heartbeatは書き込み間隔を過ぎたworkerの最終応答を更新する', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun();
    await request(harness.app, `${fixture.basePath}/jobs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
    });
    const claimed = (await claim(fixture.workerToken, { workerId: 'host-1' })).item!;
    await harness.database.query("UPDATE workers SET last_seen_at=now()-interval '90 seconds'");
    const aged = await lastSeenAt('host-1');
    await request(harness.app, `/api/worker/jobs/${claimed.job.id}/heartbeat`, {
      method: 'POST',
      token: fixture.workerToken,
      body: { leaseId: claimed.job.leaseId },
    });
    expect((await lastSeenAt('host-1')).getTime()).toBeGreaterThan(aged.getTime());
  });

  it('別projectのworkerは見えず、viewerは読めるがscope不足と全体一覧の非管理者は403', async () => {
    const fixture = await executionFixture(harness);
    await claim(fixture.workerToken, { workerId: 'host-a' });
    const otherProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherToken = (
      await entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: {
            name: 'Other Worker',
            kind: 'service',
            projectId: otherProject.id,
            scopes: ['worker:execute', 'read'],
          },
        }),
      )
    ).token;
    await claim(otherToken, { workerId: 'host-b' });

    const visibleToViewer = await listWorkers(`${fixture.basePath}/workers`, fixture.viewer.cookie);
    expect(visibleToViewer.map((worker) => worker.workerId)).toEqual(['host-a']);
    const visibleToOther = await entity<{ items: WorkerPresence[] }>(
      await request(harness.app, `/api/projects/${otherProject.id}/workers`, {
        token: otherToken,
      }),
      200,
    );
    expect(visibleToOther.items.map((worker) => worker.workerId)).toEqual(['host-b']);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/workers`, {
          token: otherToken,
        })
      ).status,
    ).toBe(403);
    // The worker token has worker:execute but not read.
    const scopeDenied = await request(harness.app, `${fixture.basePath}/workers`, {
      token: fixture.workerToken,
    });
    expect(scopeDenied.status).toBe(403);
    expect((await scopeDenied.json()).code).toBe('insufficient_scope');
    expect(
      (
        await request(harness.app, `${fixture.basePath}/workers`, {
          cookie: fixture.outsider.cookie,
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await request(harness.app, '/api/workers', {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(403);
    const all = await listWorkers('/api/workers', fixture.administrator.cookie);
    expect(all.map((worker) => worker.workerId).sort()).toEqual(['host-a', 'host-b']);
  });

  it('workerInfoの不正な値は422で拒否する', async () => {
    const fixture = await executionFixture(harness);
    const response = await request(harness.app, '/api/worker/claim', {
      method: 'POST',
      token: fixture.workerToken,
      body: { workerId: 'host-1', workerInfo: { parallelJobs: 0 } },
    });
    expect(response.status).toBe(422);
    expect((await harness.database.query('SELECT 1 FROM workers')).rows).toHaveLength(0);
  });
});
