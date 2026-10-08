import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ComputeTarget,
  TargetCheck,
  TargetCheckResult,
  WorkerTargetCheck,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

const SSH_KEY_PATH = '/home/worker/.ssh/id_gpu_host';

const passingResult: TargetCheckResult = {
  version: 1,
  items: [
    { name: 'connection', status: 'ok', code: null, detail: null },
    { name: 'python', status: 'ok', code: null, detail: '3.11.9 /usr/bin/python3' },
    { name: 'docker', status: 'ng', code: 'docker_socket_denied', detail: '27.1.1' },
    { name: 'gpu', status: 'ok', code: null, detail: null },
  ],
  gpus: [
    {
      index: '0',
      uuid: 'GPU-6f1b3c2a-0000-1111-2222-333344445555',
      name: 'NVIDIA A100-SXM4-80GB',
      memoryTotalMiB: 81920,
    },
  ],
  runtimeKinds: ['python'],
  workDirectoryFreeBytes: 1_000_000_000,
};

describe.skipIf(!testDatabaseUrl)('Computeの接続確認（独立PostgreSQL）', () => {
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

  async function setup() {
    const fixture = await executionFixture(harness);
    const sshTarget = await entity<ComputeTarget>(
      await request(harness.app, '/api/targets', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'GPU host',
          host: 'gpu-host.internal',
          port: 22,
          username: 'mmt',
          sshKeyPath: SSH_KEY_PATH,
          knownHostsPath: '/home/worker/.ssh/known_hosts',
          workDirectory: '/srv/mmt',
          pythonExecutable: 'python3',
          gpuIds: [],
          maxConcurrentJobs: 1,
          enabled: false,
          executor: 'ssh',
        },
      }),
    );
    const secondWorkerToken = (
      await entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: {
            name: 'Second Worker',
            kind: 'service',
            projectId: fixture.project.id,
            scopes: ['worker:execute'],
          },
        }),
      )
    ).token;
    return { ...fixture, sshTarget, secondWorkerToken };
  }

  async function requestCheck(cookie: string, targetId: string): Promise<TargetCheck> {
    return entity<TargetCheck>(
      await request(harness.app, `/api/targets/${targetId}/checks`, { method: 'POST', cookie }),
    );
  }

  async function claim(token: string, body: Record<string, unknown>) {
    return request(harness.app, '/api/worker/target-checks/claim', {
      method: 'POST',
      token,
      body,
    });
  }

  async function claimItem(token: string, body: Record<string, unknown>) {
    return (await entity<{ item: WorkerTargetCheck | null }>(await claim(token, body), 200)).item;
  }

  async function complete(token: string, checkId: string, body: Record<string, unknown>) {
    return request(harness.app, `/api/worker/target-checks/${checkId}/complete`, {
      method: 'POST',
      token,
      body,
    });
  }

  it('全体管理者だけが接続確認を依頼・閲覧でき、実行中は重ねて依頼できない', async () => {
    const fixture = await setup();
    const path = `/api/targets/${fixture.sshTarget.id}/checks`;
    for (const cookie of [fixture.editor.cookie, fixture.viewer.cookie]) {
      expect((await request(harness.app, path, { method: 'POST', cookie })).status).toBe(403);
      expect((await request(harness.app, path, { cookie })).status).toBe(403);
    }
    // A worker token cannot queue SSH sessions either.
    expect(
      (await request(harness.app, path, { method: 'POST', token: fixture.workerToken })).status,
    ).toBe(403);

    const check = await requestCheck(fixture.administrator.cookie, fixture.sshTarget.id);
    expect(check).toMatchObject({
      targetId: fixture.sshTarget.id,
      requestedBy: fixture.administrator.userId,
      status: 'queued',
      result: null,
    });
    const again = await request(harness.app, path, {
      method: 'POST',
      cookie: fixture.administrator.cookie,
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('target_check_in_progress');
    expect(
      (
        await request(harness.app, '/api/targets/00000000-0000-4000-8000-000000000000/checks', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('担当外targetの接続確認はclaimできず、targetIdsの無いclaimは拒否する', async () => {
    const fixture = await setup();
    await requestCheck(fixture.administrator.cookie, fixture.sshTarget.id);
    expect(
      await claimItem(fixture.workerToken, { workerId: 'host-1', targetIds: [fixture.target.id] }),
    ).toBeNull();
    // A worker without MMT_WORKER_TARGET_IDS is not in charge of any particular target.
    expect((await claim(fixture.workerToken, { workerId: 'host-1' })).status).toBe(422);
    expect((await claim(fixture.workerToken, { workerId: 'host-1', targetIds: [] })).status).toBe(
      422,
    );
    // Session users (even administrators) cannot claim.
    expect(
      (
        await request(harness.app, '/api/worker/target-checks/claim', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { workerId: 'host-1', targetIds: [fixture.sshTarget.id] },
        })
      ).status,
    ).toBe(403);
  });

  it('同じ接続確認を二重にclaimせず、同じworkerの再送には同じleaseを返す', async () => {
    const fixture = await setup();
    const check = await requestCheck(fixture.administrator.cookie, fixture.sshTarget.id);
    const body = { workerId: 'host-1', targetIds: [fixture.sshTarget.id] };
    const [first, second] = await Promise.all([
      claimItem(fixture.workerToken, body),
      claimItem(fixture.secondWorkerToken, { ...body, workerId: 'host-2' }),
    ]);
    const claims = [first, second].filter((item) => item !== null);
    expect(claims).toHaveLength(1);
    const claimed = claims[0]!;
    expect(claimed.check).toMatchObject({ id: check.id, status: 'claimed' });
    // The worker needs the full target (key path on its own host) to connect.
    expect(claimed.target.sshKeyPath).toBe(SSH_KEY_PATH);

    const winnerToken = first ? fixture.workerToken : fixture.secondWorkerToken;
    const winnerBody = first ? body : { ...body, workerId: 'host-2' };
    const replay = await claimItem(winnerToken, winnerBody);
    expect(replay).toMatchObject({ leaseId: claimed.leaseId, check: { id: check.id } });
    const loserToken = first ? fixture.secondWorkerToken : fixture.workerToken;
    const loserBody = first ? { ...body, workerId: 'host-2' } : body;
    expect(await claimItem(loserToken, loserBody)).toBeNull();

    const listed = await entity<{ items: Record<string, unknown>[] }>(
      await request(harness.app, `/api/targets/${fixture.sshTarget.id}/checks`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(listed.items[0]).toMatchObject({ status: 'claimed', workerId: winnerBody.workerId });
    expect(listed.items[0]).not.toHaveProperty('leaseId');
    expect(listed.items[0]).not.toHaveProperty('workerTokenId');
  });

  it('completeの再送は冪等で、別のleaseや異なる状態の再送は拒否する', async () => {
    const fixture = await setup();
    await requestCheck(fixture.administrator.cookie, fixture.sshTarget.id);
    const claimed = (await claimItem(fixture.workerToken, {
      workerId: 'host-1',
      targetIds: [fixture.sshTarget.id],
    }))!;
    const body = { leaseId: claimed.leaseId, status: 'finished', result: passingResult };
    const wrongLease = await complete(fixture.workerToken, claimed.check.id, {
      ...body,
      leaseId: '00000000-0000-4000-8000-000000000000',
    });
    expect(wrongLease.status).toBe(409);
    // Another worker token cannot complete with a stolen lease either.
    expect((await complete(fixture.secondWorkerToken, claimed.check.id, body)).status).toBe(409);

    const finished = await entity<TargetCheck>(
      await complete(fixture.workerToken, claimed.check.id, body),
      200,
    );
    expect(finished).toMatchObject({ status: 'finished', result: passingResult });
    expect(finished.finishedAt).not.toBeNull();
    const resent = await entity<TargetCheck>(
      await complete(fixture.workerToken, claimed.check.id, body),
      200,
    );
    expect(resent).toEqual(finished);
    const changed = await complete(fixture.workerToken, claimed.check.id, {
      ...body,
      status: 'failed',
    });
    expect(changed.status).toBe(409);
    // A finished check frees the target for the next request.
    await requestCheck(fixture.administrator.cookie, fixture.sshTarget.id);
  });

  it('鍵のパス・token・秘密鍵を含む結果や過大な結果は保存しない', async () => {
    const fixture = await setup();
    await requestCheck(fixture.administrator.cookie, fixture.sshTarget.id);
    const claimed = (await claimItem(fixture.workerToken, {
      workerId: 'host-1',
      targetIds: [fixture.sshTarget.id],
    }))!;
    const withDetail = (detail: string): TargetCheckResult => ({
      ...passingResult,
      items: [{ name: 'connection', status: 'ng', code: 'ssh_failed', detail }],
    });
    for (const result of [
      withDetail(`Warning: Identity file ${SSH_KEY_PATH} not accessible`),
      withDetail('MMT_API_TOKEN=mmt_abcdefghijklmnopqrstuvwxyz'),
      withDetail('-----BEGIN OPENSSH PRIVATE KEY-----'),
    ]) {
      const response = await complete(fixture.workerToken, claimed.check.id, {
        leaseId: claimed.leaseId,
        status: 'finished',
        result,
      });
      expect(response.status).toBe(422);
      expect(((await response.json()) as { code: string }).code).toBe(
        'target_check_secret_in_result',
      );
    }
    const oversized = await complete(fixture.workerToken, claimed.check.id, {
      leaseId: claimed.leaseId,
      status: 'finished',
      result: {
        ...passingResult,
        gpus: Array.from({ length: 64 }, (_, index) => ({
          index: String(index),
          uuid: `GPU-${'u'.repeat(190)}`,
          name: 'n'.repeat(200),
          memoryTotalMiB: 1,
        })),
      },
    });
    expect(oversized.status).toBe(422);
    // Unknown fields and free-form output are rejected by the schema.
    const rawOutput = await complete(fixture.workerToken, claimed.check.id, {
      leaseId: claimed.leaseId,
      status: 'finished',
      result: { ...passingResult, stderr: 'ssh: connect to host' },
    });
    expect(rawOutput.status).toBe(422);
    const stored = await harness.database.query('SELECT result FROM target_checks');
    expect(stored.rows[0].result).toBeNull();
  });

  it('claimされない接続確認と報告の無い接続確認は期限切れの失敗になる', async () => {
    const fixture = await setup();
    const queued = await requestCheck(fixture.administrator.cookie, fixture.sshTarget.id);
    await requestCheck(fixture.administrator.cookie, fixture.target.id);
    await harness.database.query(
      "UPDATE target_checks SET created_at=now()-interval '301 seconds' WHERE id=$1",
      [queued.id],
    );
    const claimed = (await claimItem(fixture.workerToken, {
      workerId: 'host-1',
      targetIds: [fixture.sshTarget.id, fixture.target.id],
    }))!;
    expect(claimed.check.targetId).toBe(fixture.target.id);
    await harness.database.query(
      "UPDATE target_checks SET claimed_at=now()-interval '301 seconds' WHERE id=$1",
      [claimed.check.id],
    );
    const [expiredQueued] = (
      await entity<{ items: TargetCheck[] }>(
        await request(harness.app, `/api/targets/${fixture.sshTarget.id}/checks`, {
          cookie: fixture.administrator.cookie,
        }),
        200,
      )
    ).items;
    expect(expiredQueued).toMatchObject({ status: 'failed', failureReason: 'no_worker' });
    const late = await complete(fixture.workerToken, claimed.check.id, {
      leaseId: claimed.leaseId,
      status: 'finished',
      result: passingResult,
    });
    expect(late.status).toBe(409);
    const [expiredClaim] = (
      await entity<{ items: TargetCheck[] }>(
        await request(harness.app, `/api/targets/${fixture.target.id}/checks`, {
          cookie: fixture.administrator.cookie,
        }),
        200,
      )
    ).items;
    expect(expiredClaim).toMatchObject({
      status: 'failed',
      failureReason: 'claim_timeout',
      result: null,
    });
  });
});
