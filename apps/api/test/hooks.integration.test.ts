import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Artifact,
  ChildJobCreated,
  ChildJobWait,
  Hook,
  HookCreated,
  HookExecution,
  HookExecutionPage,
  Job,
  JobArrayCreated,
  ModelVersion,
  Run,
  RunCheckpoint,
  RunnerFinishResult,
  RunnerState,
  ServiceAccount,
  WorkerJob,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { runnerRequest, siteFixture, type SiteFixture } from './siteFixtures.js';

const HOOK_SECRET_KEY = randomBytes(32).toString('base64');

describe.skipIf(!testDatabaseUrl)('フック・webhook・ドライバー（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: SiteFixture;
  beforeAll(async () => {
    harness = await createHarness({ environment: { MMT_HOOK_SECRET_KEY: HOOK_SECRET_KEY } });
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await siteFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  // A Job on the local target running the fixture's Python Code.
  function template(overrides: Record<string, unknown> = {}) {
    return {
      experimentId: fixture.experiment.id,
      kind: 'inference',
      codeVersionId: fixture.codeVersion.id,
      modelVersionId: fixture.modelVersion.id,
      targetId: fixture.target.id,
      ...overrides,
    };
  }

  async function createHook(body: Record<string, unknown>): Promise<HookCreated> {
    return entity<HookCreated>(
      await request(harness.app, `${fixture.basePath}/hooks`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Hook', template: template(), ...body },
      }),
    );
  }

  async function executions(hookId: string): Promise<HookExecution[]> {
    const page = await entity<HookExecutionPage>(
      await request(harness.app, `${fixture.basePath}/hook-executions?hookId=${hookId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    return page.items;
  }

  async function startLocalJob(
    run: Run,
    options: { workerId?: string; body?: Record<string, unknown> } = {},
  ): Promise<WorkerJob> {
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, ...options.body },
      }),
    );
    const claimed = await claimLocal(options.workerId ?? `worker-${randomUUID()}`);
    expect(claimed.job.id).toBe(job.id);
    return claimed;
  }

  async function claimLocal(workerId: string): Promise<WorkerJob> {
    const claimed = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId },
      }),
      200,
    );
    return claimed.item!;
  }

  async function completeLocal(workerJob: WorkerJob, status = 'finished'): Promise<void> {
    await entity<Job>(
      await request(harness.app, `/api/worker/jobs/${workerJob.job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: workerJob.job.leaseId, status, exitCode: status === 'finished' ? 0 : 1 },
      }),
      200,
    );
  }

  async function trainingRun(): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Training',
          kind: 'training',
          codeVersionId: fixture.codeVersion.id,
          modelVersionId: fixture.modelVersion.id,
        },
      }),
    );
  }

  async function saveCheckpoint(runId: string, step: number): Promise<RunCheckpoint> {
    const artifact = await entity<Artifact>(
      await request(
        harness.app,
        `${fixture.basePath}/runs/${runId}/artifacts?path=checkpoints/step-${step}.tar`,
        {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: `checkpoint ${step}`,
          headers: { 'Content-Type': 'application/x-tar' },
        },
      ),
    );
    return entity<RunCheckpoint>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}/checkpoints`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          step,
          artifactId: artifact.id,
          manifest: { files: [{ path: 'model.pt', sha256: 'a'.repeat(64), size: 7 }], includesOptimizer: false },
          metadata: {},
        },
      }),
    );
  }

  it('手動のフックはpayloadと一緒にJobを起動し、同じkeyの再送は同じ起動を返す', async () => {
    const { hook, webhookSecret, webhookPath } = await createHook({ trigger: 'manual' });
    expect(hook).toMatchObject({ trigger: 'manual', enabled: true, runAsUserId: fixture.editor.userId });
    expect([webhookSecret, webhookPath]).toEqual([null, null]);
    const trigger = () =>
      request(harness.app, `${fixture.basePath}/hooks/${hook.id}/trigger`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { payload: { prompt: 'hello' }, idempotencyKey: 'build-1' },
      });
    const execution = await entity<HookExecution>(await trigger());
    expect(execution).toMatchObject({
      status: 'queued',
      subjectKind: 'manual',
      requestedBy: fixture.editor.userId,
      jobStatus: 'queued',
    });
    expect((await entity<HookExecution>(await trigger())).id).toBe(execution.id);
    const workerJob = await claimLocal('worker-manual');
    expect(workerJob.job).toMatchObject({ id: execution.jobId, hookId: hook.id, chainDepth: 1 });
    expect(workerJob.triggerPayload).toEqual({ prompt: 'hello' });
    expect(workerJob.run.tags).toMatchObject({ 'mmt.hookId': hook.id, 'mmt.hookExecutionId': execution.id });

    const runHook = await createHook({ name: 'On run', trigger: 'run_finished' });
    const notManual = await request(harness.app, `${fixture.basePath}/hooks/${runHook.hook.id}/trigger`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {},
    });
    expect(await notManual.json()).toMatchObject({ code: 'hook_not_manual' });
    await entity(
      await request(harness.app, `${fixture.basePath}/hooks/${hook.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { enabled: false },
      }),
      200,
    );
    const disabled = await request(harness.app, `${fixture.basePath}/hooks/${hook.id}/trigger`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {},
    });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ code: 'hook_disabled' });
  });

  it('Project adminはフックをService Accountへ移せ、以後の起動はService Accountとして動く', async () => {
    const { hook } = await createHook({ trigger: 'manual' });
    const serviceAccount = async (role: 'viewer' | 'editor') =>
      entity<ServiceAccount>(
        await request(harness.app, `${fixture.basePath}/service-accounts`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { name: `Hook ${role}`, role, description: 'Runs hooks' },
        }),
      );
    const owner = await serviceAccount('editor');
    const reader = await serviceAccount('viewer');
    const transfer = (serviceAccountId: string, cookie = fixture.administrator.cookie) =>
      request(harness.app, `${fixture.basePath}/hooks/${hook.id}/owner`, {
        method: 'PUT',
        cookie,
        body: { serviceAccountId },
      });
    expect((await transfer(owner.id, fixture.editor.cookie)).status).toBe(403);
    for (const refused of [reader.id, fixture.editor.userId]) {
      const response = await transfer(refused);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'invalid_hook_owner' });
    }
    const moved = await entity<Hook>(await transfer(owner.id), 200);
    expect(moved).toMatchObject({
      runAsUserId: owner.id,
      runAsKind: 'service',
      createdBy: fixture.editor.userId,
    });
    // The same owner again changes nothing and is not audited again.
    await entity<Hook>(await transfer(owner.id), 200);
    const audits = await harness.database.query<{ outcome: string }>(
      "SELECT outcome FROM audit_events WHERE action='hook.owner.transfer' ORDER BY occurred_at,id",
    );
    expect(audits.rows.map((row) => row.outcome)).toEqual(['denied', 'success']);
    const execution = await entity<HookExecution>(
      await request(harness.app, `${fixture.basePath}/hooks/${hook.id}/trigger`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {},
      }),
    );
    const { rows } = await harness.database.query<{ created_by: string }>(
      'SELECT created_by FROM runs WHERE id=$1',
      [execution.runId],
    );
    expect(rows[0]!.created_by).toBe(owner.id);
    // Only enabled and the owner can change; the rest of the hook stays as it was created.
    await expect(
      harness.database.query("UPDATE hooks SET name='Renamed' WHERE id=$1", [hook.id]),
    ).rejects.toThrow('immutable');
  });

  it('SSOのgroup同期が古い所有者のフックも起動し、そのJob tokenも使える', async () => {
    const { hook } = await createHook({ trigger: 'manual' });
    // The owner last signed in by SSO a month ago: their own API token is stopped by the sync
    // expiry, but a hook keeps running for as long as its owner is an editor.
    await harness.database.query(
      `INSERT INTO user_oidc_identities(issuer,subject,user_id,email_at_login,email_verified,groups_synced_at)
      VALUES ('https://sso.example.org','hook-owner',$1,'owner@example.org',true,now()-interval '30 days')`,
      [fixture.editor.userId],
    );
    const stale = await request(harness.app, `${fixture.basePath}/hooks`, {
      token: fixture.personalToken,
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ code: 'identity_sync_required' });
    const execution = await entity<HookExecution>(
      await request(harness.app, `${fixture.basePath}/hooks/${hook.id}/trigger`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {},
      }),
    );
    expect(execution).toMatchObject({ status: 'queued', jobStatus: 'queued' });
    const workerJob = await claimLocal('worker-stale-owner');
    expect(workerJob.job.id).toBe(execution.jobId);
    const run = await request(harness.app, `${fixture.basePath}/runs/${execution.runId}`, {
      token: workerJob.jobToken!,
    });
    expect(run.status).toBe(200);
  });

  it('Runの終了で起動し、自分が起動したJobの終了では循環として止まる', async () => {
    const { hook } = await createHook({
      trigger: 'run_finished',
      filter: { runKinds: ['inference'], runStatuses: ['finished'] },
    });
    const first = await startLocalJob(await fixture.newRun('Person run'));
    await completeLocal(first);
    const [started] = await executions(hook.id);
    expect(started).toMatchObject({ status: 'queued', subjectKind: 'run', subjectId: first.run.id });
    const hookJob = await claimLocal('worker-hook');
    expect(hookJob.job).toMatchObject({ id: started!.jobId, chainDepth: 1 });
    expect(hookJob.run.parentRunId).toBe(first.run.id);
    await completeLocal(hookJob);
    const [loop] = await executions(hook.id);
    expect(loop).toMatchObject({ status: 'skipped', reason: 'loop_detected', subjectId: hookJob.run.id });
    // A failed Run is outside the filter and leaves no execution.
    const failed = await startLocalJob(await fixture.newRun('Failing run'));
    await completeLocal(failed, 'failed');
    expect(await executions(hook.id)).toHaveLength(2);
  });

  it('学習中に登録された版は学習Runの成功を待ってから起動する', async () => {
    // A registration has no end status, so this condition could never match.
    const unusable = await request(harness.app, `${fixture.basePath}/hooks`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        name: 'Never',
        trigger: 'model_registered',
        filter: { runStatuses: ['finished'] },
        template: template({ modelVersionId: null }),
      },
    });
    expect(unusable.status).toBe(422);
    expect(await unusable.json()).toMatchObject({ code: 'invalid_request' });
    const { hook } = await createHook({
      trigger: 'model_registered',
      filter: { modelFamilies: ['qwen2'] },
      template: template({ modelVersionId: null }),
    });
    const training = await startLocalJob(await trainingRun());
    const version = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'trained', sourceRunId: training.run.id },
      }),
    );
    const [pending] = await executions(hook.id);
    expect(pending).toMatchObject({
      status: 'pending',
      subjectKind: 'model_version',
      subjectId: version.id,
      waitingRunId: training.run.id,
    });
    await completeLocal(training);
    const [started] = await executions(hook.id);
    expect(started).toMatchObject({ id: pending!.id, status: 'queued' });
    const { rows } = await harness.database.query<{ model_version_id: string }>(
      'SELECT model_version_id FROM runs WHERE id=$1',
      [started!.runId],
    );
    expect(rows[0]!.model_version_id).toBe(version.id);
  });

  it('latestでは評価中に保存されたcheckpointのうち最新だけが待ち、前の評価が終わると起動する', async () => {
    const { hook } = await createHook({
      trigger: 'checkpoint_saved',
      checkpointMode: 'latest',
      template: template({ inheritModelVersion: true }),
    });
    const training = await startLocalJob(await trainingRun());
    const first = await saveCheckpoint(training.run.id, 1);
    const second = await saveCheckpoint(training.run.id, 2);
    const third = await saveCheckpoint(training.run.id, 3);
    const byCheckpoint = async () =>
      Object.fromEntries((await executions(hook.id)).map((item) => [item.checkpointId, item]));
    let recorded = await byCheckpoint();
    expect(recorded[first.id]).toMatchObject({ status: 'queued' });
    expect(recorded[second.id]).toMatchObject({ status: 'skipped', reason: 'superseded' });
    expect(recorded[third.id]).toMatchObject({ status: 'pending' });
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs/${recorded[first.id]!.jobId}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    recorded = await byCheckpoint();
    expect(recorded[third.id]).toMatchObject({ status: 'queued' });
    const evaluation = await claimLocal('worker-evaluation');
    expect(evaluation.job.id).toBe(recorded[third.id]!.jobId);
    expect(evaluation.inputCheckpoint).toMatchObject({ id: third.id, runId: training.run.id, step: 3 });
    expect(evaluation.triggerPayload).toMatchObject({ event: 'checkpoint_saved', step: 3 });
  });

  it('署名の合うwebhookだけを受け、同じ配信IDの再送は同じ起動を返す', async () => {
    const github = await createHook({ name: 'Push', trigger: 'webhook', webhookSignature: 'github' });
    expect(github.webhookPath).toBe(`/api/hooks/${github.hook.id}/webhook`);
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const signature = `sha256=${createHmac('sha256', github.webhookSecret!).update(body).digest('hex')}`;
    const deliver = (headers: Record<string, string>) =>
      request(harness.app, github.webhookPath!, {
        method: 'POST',
        binary: body,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    const accepted = await entity<{ accepted: boolean; executionId: string }>(
      await deliver({ 'X-Hub-Signature-256': signature, 'X-GitHub-Delivery': 'delivery-1' }),
      202,
    );
    const resent = await entity<{ executionId: string }>(
      await deliver({ 'X-Hub-Signature-256': signature, 'X-GitHub-Delivery': 'delivery-1' }),
      202,
    );
    expect(resent.executionId).toBe(accepted.executionId);
    const forged = await deliver({ 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ code: 'invalid_signature' });
    const workerJob = await claimLocal('worker-webhook');
    expect(workerJob.triggerPayload).toEqual({ ref: 'refs/heads/main' });

    const mmt = await createHook({ name: 'CI', trigger: 'webhook', webhookSignature: 'mmt' });
    const signed = (timestamp: number) =>
      `t=${timestamp},v1=${createHmac('sha256', mmt.webhookSecret!).update(`${timestamp}.${body}`).digest('hex')}`;
    const now = Math.floor(Date.now() / 1000);
    const fresh = await request(harness.app, mmt.webhookPath!, {
      method: 'POST',
      binary: body,
      headers: { 'Content-Type': 'application/json', 'X-MMT-Signature': signed(now) },
    });
    expect(fresh.status).toBe(202);
    const replayed = await request(harness.app, mmt.webhookPath!, {
      method: 'POST',
      binary: body,
      headers: { 'Content-Type': 'application/json', 'X-MMT-Signature': signed(now - 3600) },
    });
    expect(replayed.status).toBe(401);
    await entity(
      await request(harness.app, `${fixture.basePath}/hooks/${mmt.hook.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { enabled: false },
      }),
      200,
    );
    const disabled = await request(harness.app, mmt.webhookPath!, {
      method: 'POST',
      binary: body,
      headers: { 'Content-Type': 'application/json', 'X-MMT-Signature': signed(now) },
    });
    expect(disabled.status).toBe(409);
  });

  it('ドライバーは自分のJob tokenで子Jobを作り、待ち、親の取消で子も止まる', async () => {
    const parent = await startLocalJob(await fixture.newRun('Driver'), {
      body: { allowChildJobs: true },
    });
    const child = {
      idempotencyKey: 'stage-1',
      name: 'Stage 1',
      kind: 'inference',
      codeVersionId: fixture.codeVersion.id,
      modelVersionId: fixture.modelVersion.id,
      targetId: fixture.target.id,
    };
    const createChild = (token: string, body: Record<string, unknown> = child) =>
      request(harness.app, `${fixture.basePath}/jobs/${parent.job.id}/children`, {
        method: 'POST',
        token,
        body,
      });
    const created = await entity<ChildJobCreated>(await createChild(parent.jobToken!));
    expect(created.created).toBe(true);
    expect(created.jobs[0]).toMatchObject({ parentJobId: parent.job.id, chainDepth: 1 });
    const resent = await entity<ChildJobCreated>(await createChild(parent.jobToken!), 200);
    expect(resent).toMatchObject({ created: false, jobs: [{ id: created.jobs[0]!.id }] });
    const { rows } = await harness.database.query<{ parent_run_id: string; created_by: string }>(
      'SELECT parent_run_id,created_by FROM runs WHERE id=$1',
      [created.jobs[0]!.runId],
    );
    expect(rows[0]).toEqual({ parent_run_id: parent.run.id, created_by: fixture.editor.userId });
    const withSession = await request(harness.app, `${fixture.basePath}/jobs/${parent.job.id}/children`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: child,
    });
    expect(await withSession.json()).toMatchObject({ code: 'driver_token_required' });
    const waited = await entity<ChildJobWait>(
      await request(harness.app, `${fixture.basePath}/jobs/${parent.job.id}/children/wait?timeoutSeconds=1`, {
        token: parent.jobToken!,
      }),
      200,
    );
    expect(waited).toMatchObject({ done: false, counts: { queued: 1, total: 1 } });
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs/${parent.job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    const children = await entity<{ items: Job[] }>(
      await request(harness.app, `${fixture.basePath}/jobs/${parent.job.id}/children`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(children.items.map((job) => job.status)).toEqual(['canceled']);

    const plain = await startLocalJob(await fixture.newRun('Plain'));
    const notAllowed = await request(harness.app, `${fixture.basePath}/jobs/${plain.job.id}/children`, {
      method: 'POST',
      token: plain.jobToken!,
      body: child,
    });
    expect(notAllowed.status).toBe(403);
    expect(await notAllowed.json()).toMatchObject({ code: 'child_jobs_not_allowed' });
  });

  it('arrayの全員が終わるとarray_finishedのフックが起動する', async () => {
    const { hook } = await createHook({ name: 'After array', trigger: 'array_finished' });
    const created = await entity<JobArrayCreated>(
      await request(harness.app, `${fixture.basePath}/job-arrays`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Generate',
          kind: 'inference',
          codeVersionId: fixture.containerCodeVersion.id,
          modelVersionId: fixture.modelVersion.id,
          targetId: fixture.site.id,
          size: 2,
        },
      }),
    );
    const submissions = await fixture.claim();
    expect(submissions).toHaveLength(2);
    for (const [index, submission] of submissions.entries()) {
      const workerJob = submission.jobs[0]!;
      await fixture.report([workerJob.job.id], { outcome: 'submitted', schedulerJobId: `${index}` });
      const instanceId = randomUUID();
      await entity<RunnerState>(
        await runnerRequest(harness, fixture, {
          jobId: workerJob.job.id,
          token: workerJob.jobToken!,
          report: 'start',
          body: { instanceId, host: 'node', gpuIds: [], phase: 'running' },
        }),
        200,
      );
      expect(await executions(hook.id)).toHaveLength(0);
      await entity<RunnerFinishResult>(
        await runnerRequest(harness, fixture, {
          jobId: workerJob.job.id,
          token: workerJob.jobToken!,
          report: 'finish',
          body: { instanceId, status: 'finished', exitCode: 0 },
        }),
        200,
      );
    }
    const [started] = await executions(hook.id);
    expect(started).toMatchObject({
      status: 'queued',
      subjectKind: 'array_group',
      subjectId: created.arrayGroup.id,
    });
    const described = await entity<JobArrayCreated>(
      await request(harness.app, `${fixture.basePath}/job-arrays/${created.arrayGroup.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(described.arrayGroup.finishedAt).not.toBeNull();
  });
});
