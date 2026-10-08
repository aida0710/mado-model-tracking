import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job, Run, WorkerJob } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

describe.skipIf(!testDatabaseUrl)('Job・GPU予約・worker lease（独立PostgreSQL）', () => {
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

  it('MLflowで削除したqueued RunにはJobを作れず、復元すると作成できる', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun();
    const trackingBase = `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow/runs`;
    expect((await request(harness.app, `${trackingBase}/delete`, {
      method: 'POST', cookie: fixture.editor.cookie, body: { run_id: run.id },
    })).status).toBe(200);
    const jobRequest = {
      method: 'POST', cookie: fixture.editor.cookie,
      body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
    };
    expect((await request(harness.app, `${fixture.basePath}/jobs`, jobRequest)).status).toBe(409);
    expect((await harness.database.query('SELECT id FROM jobs')).rows).toHaveLength(0);
    expect((await request(harness.app, `${trackingBase}/restore`, {
      method: 'POST', cookie: fixture.editor.cookie, body: { run_id: run.id },
    })).status).toBe(200);
    expect((await request(harness.app, `${fixture.basePath}/jobs`, jobRequest)).status).toBe(201);
  });

  it('同時claimでも同じGPUを予約するJobは一つだけになる', async () => {
    const fixture = await executionFixture(harness);
    const runs = await Promise.all([fixture.newRun('First'), fixture.newRun('Second')]);
    for (const run of runs)
      await entity<Job>(
        await request(harness.app, `${fixture.basePath}/jobs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
        }),
      );
    const claims = await Promise.all(
      ['worker-one', 'worker-two'].map((workerId) =>
        request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId },
        }).then((response) => entity<{ item: WorkerJob | null }>(response, 200)),
      ),
    );
    expect(claims.filter((claim) => claim.item)).toHaveLength(1);
    const reserved = await harness.database.query('SELECT job_id FROM gpu_reservations');
    expect(reserved.rows).toHaveLength(1);
    expect(claims.find((claim) => claim.item)!.item!.job.id).toBe(reserved.rows[0].job_id);
    expect(claims.find((claim) => claim.item)!.item!.run.status).toBe('running');
  });

  it('同じworkerの重複claimとresumeは同じleaseを返し、二重起動の新leaseを作らない', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun();
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    const claims = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'stable-worker' },
        }).then((response) => entity<{ item: WorkerJob }>(response, 200)),
      ),
    );
    expect(new Set(claims.map((claim) => claim.item.job.leaseId)).size).toBe(1);
    expect(claims.every((claim) => claim.item.job.id === job.id)).toBe(true);
    const resumed = await entity<{ items: WorkerJob[] }>(
      await request(harness.app, '/api/worker/resume', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'stable-worker' },
      }),
      200,
    );
    expect(resumed.items[0]!.job.leaseId).toBe(claims[0]!.item.job.leaseId);
    const wrongWorker = await entity<{ items: WorkerJob[] }>(
      await request(harness.app, '/api/worker/resume', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'different-worker' },
      }),
      200,
    );
    expect(wrongWorker.items).toEqual([]);
  });

  it('SKIP LOCKEDは別transactionでロックされた先頭Jobを飛ばして次をclaimする', async () => {
    const fixture = await executionFixture(harness);
    const firstRun = await fixture.newRun('Locked');
    const firstJob = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: firstRun.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    const secondRun = await fixture.newRun('Available');
    const secondJob = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: secondRun.id, targetId: fixture.target.id, gpuIds: ['1'] },
      }),
    );
    const blocker = await harness.database.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [firstJob.id]);
      const claimed = await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'unblocked-worker' },
        }),
        200,
      );
      expect(claimed.item.job.id).toBe(secondJob.id);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('activeJobIdsで監視済みJobを指定すると同じworkerが次をclaimでき、再送は同じ新leaseを返す', async () => {
    const fixture = await executionFixture(harness);
    for (const gpuId of ['0', '1']) {
      const run = await fixture.newRun(`Concurrent ${gpuId}`);
      await entity(
        await request(harness.app, `${fixture.basePath}/jobs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { runId: run.id, targetId: fixture.target.id, gpuIds: [gpuId] },
        }),
      );
    }
    const firstClaim = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'parallel-worker', activeJobIds: [] },
        }),
        200,
      )
    ).item;
    const payload = { workerId: 'parallel-worker', activeJobIds: [firstClaim.job.id] };
    const nextClaims = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: payload,
        }).then((response) => entity<{ item: WorkerJob }>(response, 200)),
      ),
    );
    expect(nextClaims[0]!.item.job.id).not.toBe(firstClaim.job.id);
    expect(nextClaims[0]!.item.job.leaseId).toBe(nextClaims[1]!.item.job.leaseId);
    const resumed = await entity<{ items: WorkerJob[] }>(
      await request(harness.app, '/api/worker/resume', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'parallel-worker' },
      }),
      200,
    );
    expect(resumed.items).toHaveLength(2);
    expect(
      (
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'parallel-worker', activeJobIds: [randomUUID()] },
        })
      ).status,
    ).toBe(409);
  });

  it('CPU JobもtargetのmaxConcurrentJobsを超えてclaimできない', async () => {
    const fixture = await executionFixture(harness);
    for (let index = 0; index < 3; index++) {
      const run = await fixture.newRun(`CPU ${index}`);
      await entity(
        await request(harness.app, `${fixture.basePath}/jobs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { runId: run.id, targetId: fixture.target.id, gpuIds: [] },
        }),
      );
    }
    const claims: (WorkerJob | null)[] = [];
    for (const workerId of ['cpu-one', 'cpu-two', 'cpu-three'])
      claims.push(
        (
          await entity<{ item: WorkerJob | null }>(
            await request(harness.app, '/api/worker/claim', {
              method: 'POST',
              token: fixture.workerToken,
              body: { workerId },
            }),
            200,
          )
        ).item,
      );
    expect(claims.filter(Boolean)).toHaveLength(2);
    const firstClaim = claims[0]!;
    await entity(
      await request(harness.app, `/api/worker/jobs/${firstClaim.job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: firstClaim.job.leaseId, status: 'finished', exitCode: 0 },
      }),
      200,
    );
    expect(
      (
        await entity<{ item: WorkerJob | null }>(
          await request(harness.app, '/api/worker/claim', {
            method: 'POST',
            token: fixture.workerToken,
            body: { workerId: 'cpu-three' },
          }),
          200,
        )
      ).item,
    ).not.toBeNull();
  });

  it('cancelRequestedや古いheartbeatではGPUを解放せず、workerの完了後に解放する', async () => {
    const fixture = await executionFixture(harness);
    const firstRun = await fixture.newRun('Cancel');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: firstRun.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    const claimed = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'cancel-worker' },
        }),
        200,
      )
    ).item;
    await harness.database.query(
      "UPDATE jobs SET heartbeat_at=now()-interval '1 day' WHERE id=$1",
      [job.id],
    );
    const pendingRun = await fixture.newRun('Wait for GPU');
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: pendingRun.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    const canceled = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(canceled.cancelRequested).toBe(true);
    expect(canceled.status).toBe('claimed');
    expect(
      (await harness.database.query('SELECT * FROM gpu_reservations WHERE job_id=$1', [job.id]))
        .rows,
    ).toHaveLength(1);
    const anotherClaim = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'another-worker' },
      }),
      200,
    );
    expect(anotherClaim.item).toBeNull();
    expect(
      (
        await request(harness.app, `${fixture.basePath}/jobs/${job.id}/retry`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
        })
      ).status,
    ).toBe(409);
    const heartbeat = await entity<{ cancelRequested: boolean }>(
      await request(harness.app, `/api/worker/jobs/${job.id}/heartbeat`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: claimed.job.leaseId, status: 'running' },
      }),
      200,
    );
    expect(heartbeat.cancelRequested).toBe(true);
    await entity(
      await request(harness.app, `/api/worker/jobs/${job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: claimed.job.leaseId, status: 'canceled' },
      }),
      200,
    );
    expect(
      (await harness.database.query('SELECT * FROM gpu_reservations WHERE job_id=$1', [job.id]))
        .rows,
    ).toHaveLength(0);
    expect(
      (
        await entity<{ item: WorkerJob }>(
          await request(harness.app, '/api/worker/claim', {
            method: 'POST',
            token: fixture.workerToken,
            body: { workerId: 'another-worker' },
          }),
          200,
        )
      ).item.run.id,
    ).toBe(pendingRun.id);
  });

  it('worker専用scope・project・leaseを確認し、不一致の状態変更を拒否する', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun();
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id },
      }),
    );
    expect(
      (
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { workerId: 'browser' },
        })
      ).status,
    ).toBe(403);
    const readToken = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Not Worker',
          kind: 'service',
          projectId: fixture.project.id,
          scopes: ['read', 'admin'],
        },
      }),
    );
    expect(
      (
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: readToken.token,
          body: { workerId: 'not-worker' },
        })
      ).status,
    ).toBe(403);
    const claim = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'real-worker' },
        }),
        200,
      )
    ).item;
    const invalidLease = await request(harness.app, `/api/worker/jobs/${job.id}/heartbeat`, {
      method: 'POST',
      token: fixture.workerToken,
      body: { leaseId: randomUUID() },
    });
    expect(invalidLease.status).toBe(409);
    expect((await invalidLease.json()).code).toBe('invalid_lease');
    const otherProject = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Another worker project' },
      }),
    );
    const otherToken = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Other Worker',
          kind: 'service',
          projectId: otherProject.id,
          scopes: ['worker:execute'],
        },
      }),
    );
    expect(
      (
        await entity<{ item: WorkerJob | null }>(
          await request(harness.app, '/api/worker/claim', {
            method: 'POST',
            token: otherToken.token,
            body: { workerId: 'real-worker' },
          }),
          200,
        )
      ).item,
    ).toBeNull();
    expect(
      (
        await request(harness.app, `/api/worker/jobs/${job.id}/complete`, {
          method: 'POST',
          token: otherToken.token,
          body: { leaseId: claim.job.leaseId, status: 'finished' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status: 'finished' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { parameters: { changed: true } },
        })
      ).status,
    ).toBe(409);
  });

  it('同じleaseの完了再送は安全で、別状態の再送は拒否し、retryは新Run/Jobを一つだけ作る', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun('Retry');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, maxAttempts: 2 },
      }),
    );
    const claim = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'retry-worker' },
        }),
        200,
      )
    ).item;
    const complete = () =>
      request(harness.app, `/api/worker/jobs/${job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: {
          leaseId: claim.job.leaseId,
          status: 'failed',
          exitCode: 1,
          error: 'Test execution failure',
        },
      });
    await entity<Job>(await complete(), 200);
    await entity<Job>(await complete(), 200);
    expect(
      (
        await request(harness.app, `/api/worker/jobs/${job.id}/complete`, {
          method: 'POST',
          token: fixture.workerToken,
          body: { leaseId: claim.job.leaseId, status: 'finished' },
        })
      ).status,
    ).toBe(409);
    const retries = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(harness.app, `${fixture.basePath}/jobs/${job.id}/retry`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
        }).then((response) => entity<{ run: Run; job: Job }>(response)),
      ),
    );
    const retry = retries[0]!;
    expect(retry.run.id).not.toBe(run.id);
    expect(retry.run.parentRunId).toBe(run.id);
    expect(retry.run.codeVersionId).toBe(run.codeVersionId);
    expect(retry.run.modelVersionId).toBe(run.modelVersionId);
    expect(retry.job.attempt).toBe(2);
    expect(retry.job.leaseId).toBeNull();
    expect(retries[1]!.job.id).toBe(retry.job.id);
    expect(
      (
        await request(harness.app, `/api/worker/jobs/${retry.job.id}/heartbeat`, {
          method: 'POST',
          token: fixture.workerToken,
          body: { leaseId: claim.job.leaseId },
        })
      ).status,
    ).toBe(409);
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${retry.job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/jobs/${retry.job.id}/retry`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
        })
      ).status,
    ).toBe(409);
  });

  it('正しいleaseだけでmetricsとlogsを保存し、非zeroの終了コードで成功を申告できない', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun('Worker telemetry');
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id },
      }),
    );
    const claim = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'telemetry-worker' },
        }),
        200,
      )
    ).item;
    const metrics = [
      { name: 'accuracy', value: 0.9, step: 1, timestamp: new Date().toISOString() },
    ];
    const entries = [
      { level: 'error', message: 'Visible worker diagnostic', timestamp: new Date().toISOString() },
    ];
    expect(
      (
        await request(harness.app, `/api/worker/jobs/${claim.job.id}/metrics`, {
          method: 'POST',
          token: fixture.workerToken,
          body: { leaseId: randomUUID(), metrics },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(harness.app, `/api/worker/jobs/${claim.job.id}/metrics`, {
          method: 'POST',
          token: fixture.workerToken,
          body: { leaseId: claim.job.leaseId, metrics },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(harness.app, `/api/worker/jobs/${claim.job.id}/logs`, {
          method: 'POST',
          token: fixture.workerToken,
          body: { leaseId: claim.job.leaseId, entries },
        })
      ).status,
    ).toBe(204);
    const stored = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(stored.latestMetrics.accuracy).toBe(0.9);
    const logs = await entity<{ items: { message: string }[] }>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}/logs`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(logs.items[0]!.message).toBe('Visible worker diagnostic');
    expect(
      (
        await request(harness.app, `/api/worker/jobs/${claim.job.id}/complete`, {
          method: 'POST',
          token: fixture.workerToken,
          body: { leaseId: claim.job.leaseId, status: 'finished', exitCode: 1 },
        })
      ).status,
    ).toBe(422);
  });

  it('Jobの重複登録・存在しないGPU・無許可のlocal targetを拒否する', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun();
    expect(
      (
        await request(harness.app, `${fixture.basePath}/jobs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['9'] },
        })
      ).status,
    ).toBe(422);
    const created = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id },
      }),
    );
    expect(
      (
        await request(harness.app, `${fixture.basePath}/jobs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { runId: run.id, targetId: fixture.target.id },
        })
      ).status,
    ).toBe(409);
    const canceled = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs/${created.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(canceled.status).toBe('canceled');
    const targets = await entity<{ items: { sshKeyPath: string; host: string }[] }>(
      await request(harness.app, '/api/targets', { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(targets.items[0]!.host).toBe('');
    expect(targets.items[0]!.sshKeyPath).toBe('');
    const { createApp } = await import('../src/app.js');
    const restricted = createApp({
      config: { ...harness.config, allowLocalExecutor: false },
      database: harness.database,
      stores: harness.stores,
    });
    const newRun = await fixture.newRun('Restricted');
    expect(
      (
        await request(restricted, `${fixture.basePath}/jobs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { runId: newRun.id, targetId: fixture.target.id },
        })
      ).status,
    ).toBe(422);
  });
});
