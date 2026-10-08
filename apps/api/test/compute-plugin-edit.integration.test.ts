import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ComputeTarget,
  Job,
  PluginConnection,
  PluginManifest,
  WorkerJob,
} from '@mmt/contracts';
import { createApplication } from '../src/app.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';
import { deferred } from './workbenchFixtures.js';

// Wait on PostgreSQL's actual lock waiter, rather than delaying a competing request by a guessed timeout.
const MAX_LOCK_OBSERVATIONS = 1000;

describe.skipIf(!testDatabaseUrl)('Compute/plugin編集と有効切替（独立PostgreSQL）', () => {
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

  it('全体管理者だけがtargetを編集し、省略したruntime/GPU設定を維持する', async () => {
    const fixture = await executionFixture(harness);
    const endpoint = `/api/targets/${fixture.target.id}`;
    for (const cookie of [fixture.editor.cookie, fixture.viewer.cookie])
      expect(
        (
          await request(harness.app, endpoint, {
            method: 'PATCH',
            cookie,
            body: { name: 'Forbidden' },
          })
        ).status,
      ).toBe(403);
    const edited = await entity<ComputeTarget>(
      await request(harness.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { name: 'Renamed', runtimeKinds: ['python', 'docker'], maxConcurrentJobs: 3 },
      }),
      200,
    );
    const renamed = await entity<ComputeTarget>(
      await request(harness.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { name: 'Again' },
      }),
      200,
    );
    expect(renamed).toMatchObject({
      runtimeKinds: edited.runtimeKinds,
      gpuIds: edited.gpuIds,
      maxConcurrentJobs: 3,
    });
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.administrator.cookie,
          body: { executor: 'ssh' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.administrator.cookie,
          body: { runtimeKinds: ['python', 'python'] },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.administrator.cookie,
          body: { host: '--unsafe' },
        })
      ).status,
    ).toBe(422);
    const token = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Jobs only', kind: 'personal', scopes: ['jobs:write'] },
      }),
    );
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          token: token.token,
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
  });

  it('queued/active Jobの接続/runtime/GPUを変更できず、disableは新規claimだけを停止する', async () => {
    const fixture = await executionFixture(harness);
    const jobs: Job[] = [];
    for (const gpuId of ['0', '1']) {
      const run = await fixture.newRun(`Job ${gpuId}`);
      jobs.push(
        await entity<Job>(
          await request(harness.app, `${fixture.basePath}/jobs`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { runId: run.id, targetId: fixture.target.id, gpuIds: [gpuId] },
          }),
        ),
      );
    }
    const endpoint = `/api/targets/${fixture.target.id}`;
    for (const changes of [
      { host: 'changed.example.test' },
      { runtimeKinds: ['docker'] },
      { gpuIds: ['0'] },
      { pythonExecutable: 'changed' },
    ])
      expect(
        (
          await request(harness.app, endpoint, {
            method: 'PATCH',
            cookie: fixture.administrator.cookie,
            body: changes,
          })
        ).status,
      ).toBe(409);
    const active = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'active-before-disable' },
        }),
        200,
      )
    ).item;
    await entity(
      await request(harness.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: false, name: 'Disabled with active Job' },
      }),
      200,
    );
    expect(
      (
        await entity<{ item: WorkerJob | null }>(
          await request(harness.app, '/api/worker/claim', {
            method: 'POST',
            token: fixture.workerToken,
            body: { workerId: 'new-while-disabled' },
          }),
          200,
        )
      ).item,
    ).toBeNull();
    const resumed = await entity<{ items: WorkerJob[] }>(
      await request(harness.app, '/api/worker/resume', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'active-before-disable' },
      }),
      200,
    );
    expect(resumed.items[0]!.job.leaseId).toBe(active.job.leaseId);
    expect(resumed.items[0]!.target.enabled).toBe(false);
    await entity(
      await request(harness.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: true },
      }),
      200,
    );
    const second = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'second-active' },
        }),
        200,
      )
    ).item;
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.administrator.cookie,
          body: { maxConcurrentJobs: 1 },
        })
      ).status,
    ).toBe(409);
    for (const worker of [active, second])
      await entity(
        await request(harness.app, `/api/worker/jobs/${worker.job.id}/complete`, {
          method: 'POST',
          token: fixture.workerToken,
          body: { leaseId: worker.job.leaseId, status: 'finished', exitCode: 0 },
        }),
        200,
      );
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.administrator.cookie,
          body: { gpuIds: [], maxConcurrentJobs: 1 },
        })
      ).status,
    ).toBe(200);
    expect(jobs.map((job) => job.id).sort()).toEqual([active.job.id, second.job.id].sort());
  });

  it('Job登録transactionのtarget lockを待ってからbusy判定し、古いGPU設定の変更を拒否する', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun('Concurrent target edit');
    const connection = await harness.database.connect();
    let patchFinished = false;
    let competing: Promise<Response> | undefined;
    try {
      await connection.query('BEGIN');
      const blockerPid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid as number;
      await harness.services.jobs.insertJob(connection, {
        run,
        input: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'], maxAttempts: 3 },
        attempt: 1,
      });
      competing = request(harness.app, `/api/targets/${fixture.target.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { gpuIds: ['1'] },
      }).then((response) => {
        patchFinished = true;
        return response;
      });
      let hasLockWaiter = false;
      for (let index = 0; index < MAX_LOCK_OBSERVATIONS && !patchFinished; index++) {
        hasLockWaiter = (
          await harness.database.query(
            'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
            [blockerPid],
          )
        ).rows[0].waiting as boolean;
        if (hasLockWaiter) break;
      }
      expect(hasLockWaiter).toBe(true);
      expect(patchFinished).toBe(false);
      await connection.query('COMMIT');
      expect((await competing).status).toBe(409);
      expect(
        (
          await harness.database.query('SELECT gpu_ids FROM compute_targets WHERE id=$1', [
            fixture.target.id,
          ])
        ).rows[0].gpu_ids,
      ).toEqual(['0', '1']);
      expect(
        (await harness.database.query('SELECT gpu_ids FROM jobs WHERE run_id=$1', [run.id])).rows[0]
          .gpu_ids,
      ).toEqual(['0']);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await competing;
    }
  });

  it('重複Job登録はworkerがtargetをロック中でもRun lockを保持して待たずに拒否する', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun('Duplicate registration');
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id },
      }),
    );
    const connection = await harness.database.connect();
    let duplicateFinished = false;
    let duplicate: Promise<Response> | undefined;
    try {
      await connection.query('BEGIN');
      const blockerPid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid as number;
      await connection.query('SELECT id FROM compute_targets WHERE id=$1 FOR UPDATE', [
        fixture.target.id,
      ]);
      duplicate = request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id },
      }).then((response) => {
        duplicateFinished = true;
        return response;
      });
      let hasLockWaiter = false;
      for (let index = 0; index < MAX_LOCK_OBSERVATIONS && !duplicateFinished; index++) {
        hasLockWaiter = (
          await harness.database.query(
            'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
            [blockerPid],
          )
        ).rows[0].waiting as boolean;
        if (hasLockWaiter) break;
      }
      expect(hasLockWaiter).toBe(false);
      expect(duplicateFinished).toBe(true);
      expect((await duplicate).status).toBe(409);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await duplicate;
    }
  });

  it('Project adminだけではplugin接続先を変更できず、token/URL編集でmanifestをクリアする', async () => {
    const fixture = await executionFixture(harness);
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'admin' },
      }),
      200,
    );
    const plugin = await entity<PluginConnection>(
      await request(harness.app, `${fixture.basePath}/plugins`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Plugin', baseUrl: 'http://127.0.0.1:4999', tokenEnv: 'FIXTURE_TOKEN' },
      }),
    );
    const manifest: PluginManifest = {
      id: 'fixture',
      name: 'Fixture',
      version: '1',
      protocolVersion: '1.0',
      capabilities: ['events'],
    };
    await harness.database.query('UPDATE plugin_connections SET manifest=$2 WHERE id=$1', [
      plugin.id,
      JSON.stringify(manifest),
    ]);
    const endpoint = `${fixture.basePath}/plugins/${plugin.id}`;
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { baseUrl: 'http://127.0.0.1:4998' },
        })
      ).status,
    ).toBe(403);
    const renamed = await entity<PluginConnection>(
      await request(harness.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { name: 'Renamed' },
      }),
      200,
    );
    expect(renamed.manifest).toEqual(manifest);
    expect(renamed.enabled).toBe(true);
    const changed = await entity<PluginConnection>(
      await request(harness.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: {
          baseUrl: 'http://127.0.0.1:4998/',
          tokenEnv: 'FIXTURE_OTHER_TOKEN',
          enabled: false,
        },
      }),
      200,
    );
    expect(changed).toMatchObject({
      manifest: null,
      enabled: false,
      baseUrl: 'http://127.0.0.1:4998',
      tokenEnv: 'FIXTURE_OTHER_TOKEN',
    });
    for (const [path, method, body] of [
      ['/check', 'POST', undefined],
      ['/metrics', 'GET', undefined],
      ['/datasets/search', 'POST', { query: '' }],
      ['/events/retry', 'POST', undefined],
    ] as const)
      expect(
        (
          await request(harness.app, endpoint + path, {
            method,
            cookie: fixture.administrator.cookie,
            body,
          })
        ).status,
      ).toBe(422);
    const bad = await request(harness.app, endpoint, {
      method: 'PATCH',
      cookie: fixture.administrator.cookie,
      body: { baseUrl: 'https://user:fixture-password@example.test/' },
    });
    expect(bad.status).toBe(422);
    expect(await bad.text()).not.toContain('fixture-password');
  });

  it('manifest取得中に接続先が変わった場合は旧manifestを保存せず409にする', async () => {
    const fixture = await executionFixture(harness);
    const entered = deferred<void>();
    const returned = deferred<PluginManifest>();
    const application = createApplication({
      config: harness.config,
      database: harness.database,
      stores: harness.stores,
      environment: { FIXTURE_TOKEN: 'fixture-only-token' },
      pluginClientFactory: () => ({
        manifest: async () => {
          entered.resolve();
          return returned.promise;
        },
        metrics: async () => ({ prometheus: '' }),
        searchDatasets: async () => ({ items: [] }),
        sendEvent: async () => undefined,
      }),
    });
    const plugin = await entity<PluginConnection>(
      await request(application.app, `${fixture.basePath}/plugins`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Concurrent plugin',
          baseUrl: 'http://127.0.0.1:4999',
          tokenEnv: 'FIXTURE_TOKEN',
        },
      }),
    );
    const endpoint = `${fixture.basePath}/plugins/${plugin.id}`;
    const checking = request(application.app, `${endpoint}/check`, {
      method: 'POST',
      cookie: fixture.administrator.cookie,
    });
    await entered.promise;
    await entity(
      await request(application.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { baseUrl: 'http://127.0.0.1:4998' },
      }),
      200,
    );
    returned.resolve({
      id: 'old',
      name: 'Old',
      version: '1',
      protocolVersion: '1.0',
      capabilities: ['events'],
    });
    expect((await checking).status).toBe(409);
    expect(
      (
        await harness.database.query('SELECT manifest FROM plugin_connections WHERE id=$1', [
          plugin.id,
        ])
      ).rows[0].manifest,
    ).toBeNull();
  });

  it('disabled pluginのqueued eventを送信せず、再enableで同じeventを一度だけ送る', async () => {
    const fixture = await executionFixture(harness);
    const sendEvent = vi.fn(async () => undefined);
    const application = createApplication({
      config: harness.config,
      database: harness.database,
      stores: harness.stores,
      environment: { FIXTURE_TOKEN: 'fixture-only-token' },
      pluginClientFactory: () => ({
        manifest: async () => ({
          id: 'fixture',
          name: 'Fixture',
          version: '1',
          protocolVersion: '1.0',
          capabilities: ['events'],
        }),
        metrics: async () => ({ prometheus: '' }),
        searchDatasets: async () => ({ items: [] }),
        sendEvent,
      }),
    });
    const plugin = await entity<PluginConnection>(
      await request(application.app, `${fixture.basePath}/plugins`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Paused plugin',
          baseUrl: 'http://127.0.0.1:4999',
          tokenEnv: 'FIXTURE_TOKEN',
        },
      }),
    );
    const run = await fixture.newRun();
    await entity(
      await request(application.app, `${fixture.basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { status: 'finished' },
      }),
      200,
    );
    const endpoint = `${fixture.basePath}/plugins/${plugin.id}`;
    await entity(
      await request(application.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: false },
      }),
      200,
    );
    expect(await application.outbox.dispatchBatch()).toBe(0);
    expect(sendEvent).not.toHaveBeenCalled();
    expect(
      (await harness.database.query('SELECT status,attempts FROM plugin_outbox')).rows[0],
    ).toMatchObject({ status: 'pending', attempts: 0 });
    await entity(
      await request(application.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: true },
      }),
      200,
    );
    expect(await application.outbox.dispatchBatch()).toBe(1);
    expect(await application.outbox.dispatchBatch()).toBe(0);
    expect(sendEvent).toHaveBeenCalledOnce();
  });
});
