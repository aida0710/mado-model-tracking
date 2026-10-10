import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ComputeTarget,
  Job,
  JobArrayCreated,
  ManualSubmissionWaiting,
  Run,
  RunnerFinishResult,
  RunnerState,
  SiteSchedulerCancellation,
  SiteSubmission,
  WorkerJob,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import {
  runnerRequest,
  siteFixture,
  siteTargetInput,
  TEST_JOB_SHELL,
  type SiteFixture,
} from './siteFixtures.js';

async function startRunner(
  harness: Harness,
  fixture: SiteFixture,
  workerJob: WorkerJob,
  phase: 'waiting_resources' | 'running' = 'running',
): Promise<{ instanceId: string; state: RunnerState }> {
  const instanceId = randomUUID();
  const state = await entity<RunnerState>(
    await runnerRequest(harness, fixture, {
      jobId: workerJob.job.id,
      token: workerJob.jobToken!,
      report: 'start',
      body: { instanceId, host: 'node-01', gpuIds: ['0'], phase },
    }),
    200,
  );
  return { instanceId, state };
}

async function findRunStatus(harness: Harness, runId: string): Promise<string> {
  const { rows } = await harness.database.query<{ status: string }>(
    'SELECT status FROM runs WHERE id=$1',
    [runId],
  );
  return rows[0]!.status;
}

describe.skipIf(!testDatabaseUrl)('site実行先・投入・runner報告（独立PostgreSQL）', () => {
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

  it('siteは接続設定を持たず、site以外は投入方式などのsite専用設定を持てない', async () => {
    const fixture = await siteFixture(harness);
    expect(fixture.site).toMatchObject({
      executor: 'site',
      datasetTransfer: 'direct',
      submissionMode: 'automatic',
      cpuArch: 'amd64',
      supportsArray: false,
      queueTimeoutSeconds: null,
    });
    const create = (body: Record<string, unknown>) =>
      request(harness.app, '/api/targets', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body,
      });
    const withHost = await create(siteTargetInput({ name: 'Bad site', host: 'login.example' }));
    expect(withHost.status).toBe(422);
    expect(await withHost.json()).toMatchObject({ code: 'site_target_settings' });
    const withPython = await create(siteTargetInput({ name: 'Python site', runtimeKinds: ['python'] }));
    expect(await withPython.json()).toMatchObject({ code: 'site_target_settings' });
    const manualSsh = await create({
      ...siteTargetInput({ name: 'Manual local' }),
      executor: 'local',
      host: '127.0.0.1',
      username: 'local',
      workDirectory: '/tmp/mmt-test-worker',
      pythonExecutable: 'python3',
      runtimeKinds: ['python'],
      submissionMode: 'manual',
    });
    expect(manualSsh.status).toBe(422);
    expect(await manualSsh.json()).toMatchObject({ code: 'site_only_setting' });
    const withoutHost = await create({
      ...siteTargetInput({ name: 'Hostless local' }),
      executor: 'local',
      runtimeKinds: ['python'],
    });
    expect(await withoutHost.json()).toMatchObject({ code: 'target_connection_required' });
  });

  it('site JobはGPU数で依頼し、pythonのCodeやGPU IDは受け付けず、workerは受け取らない', async () => {
    const fixture = await siteFixture(harness);
    const pythonRun = await fixture.newRun('Python on site');
    const python = await request(harness.app, `${fixture.basePath}/jobs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { runId: pythonRun.id, targetId: fixture.site.id },
    });
    expect(await python.json()).toMatchObject({ code: 'incompatible_runtime' });
    const run = await fixture.newContainerRun();
    const gpuIds = await request(harness.app, `${fixture.basePath}/jobs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { runId: run.id, targetId: fixture.site.id, gpuIds: ['0'] },
    });
    expect(await gpuIds.json()).toMatchObject({ code: 'site_gpu_ids' });
    const localRun = await fixture.newContainerRun('On local');
    const gpuCountOnLocal = await request(harness.app, `${fixture.basePath}/jobs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { runId: localRun.id, targetId: fixture.target.id, gpuCount: 1 },
    });
    expect(await gpuCountOnLocal.json()).toMatchObject({ code: 'site_only_setting' });
    // docker Code runs on an Apptainer-only site: the runner converts the image to a SIF.
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.site.id, gpuCount: 2, walltimeSeconds: 3600 },
      }),
    );
    expect(job).toMatchObject({ phase: null, gpuCount: 2, walltimeSeconds: 3600, gpuIds: [] });
    const claimed = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'worker-1' },
      }),
      200,
    );
    expect(claimed.item).toBeNull();
  });

  it('launcherが投入しrunnerが報告すると、Runはコンテナの起動時にrunningになり終了で閉じる', async () => {
    const fixture = await siteFixture(harness);
    const job = await fixture.newSiteJob();
    const [submission] = await fixture.claim();
    expect(submission).toMatchObject({
      target: { id: fixture.site.id },
      arrayGroupId: null,
      requester: { id: fixture.editor.userId },
    });
    const workerJob = submission!.jobs[0]!;
    expect(workerJob.job).toMatchObject({ id: job.id, status: 'claimed', phase: 'submitting' });
    expect(workerJob.jobToken).toMatch(/^mmtj_/);
    expect(await findRunStatus(harness, job.runId)).toBe('queued');
    expect(await fixture.claim()).toEqual([]);

    const reported = await entity<{ items: Job[] }>(
      await fixture.report([job.id], { outcome: 'submitted', schedulerJobId: '12345.pbs' }),
      200,
    );
    expect(reported.items[0]).toMatchObject({ phase: 'submitted', schedulerJobId: '12345.pbs' });
    expect(reported.items[0]!.heartbeatStale).toBe(false);
    // A resend returns the same state.
    expect((await fixture.report([job.id], { outcome: 'submitted', schedulerJobId: '12345.pbs' })).status).toBe(200);

    const { instanceId, state } = await startRunner(harness, fixture, workerJob, 'waiting_resources');
    expect(state).toMatchObject({ cancelRequested: false, job: { phase: 'waiting_resources', status: 'claimed' } });
    expect(await findRunStatus(harness, job.runId)).toBe('queued');
    const heartbeat = await entity<RunnerState>(
      await runnerRequest(harness, fixture, {
        jobId: job.id,
        token: workerJob.jobToken!,
        report: 'heartbeat',
        body: { instanceId, phase: 'running' },
      }),
      200,
    );
    expect(heartbeat.job).toMatchObject({ phase: 'running', status: 'running', runnerHost: 'node-01' });
    expect(await findRunStatus(harness, job.runId)).toBe('running');
    expect(
      (
        await runnerRequest(harness, fixture, {
          jobId: job.id,
          token: workerJob.jobToken!,
          report: 'metrics',
          body: {
            instanceId,
            metrics: [{ name: 'loss', value: 0.5, step: 1, timestamp: new Date().toISOString() }],
          },
        })
      ).status,
    ).toBe(204);
    const finished = await entity<RunnerFinishResult>(
      await runnerRequest(harness, fixture, {
        jobId: job.id,
        token: workerJob.jobToken!,
        report: 'finish',
        body: { instanceId, status: 'finished', exitCode: 0 },
      }),
      200,
    );
    expect(finished).toMatchObject({ retryJobId: null, job: { status: 'finished', endReason: null } });
    expect(await findRunStatus(harness, job.runId)).toBe('finished');
    // The Job token ends with its Job.
    const afterEnd = await runnerRequest(harness, fixture, {
      jobId: job.id,
      token: workerJob.jobToken!,
      report: 'heartbeat',
      body: { instanceId },
    });
    expect(afterEnd.status).toBe(401);
  });

  it('別のinstanceや別のJobのtokenはrunnerとして報告できない', async () => {
    const fixture = await siteFixture(harness);
    const first = await fixture.newSiteJob();
    const second = await fixture.newSiteJob();
    const submissions = await fixture.claim();
    const [firstJob, secondJob] = submissions.map((submission) => submission.jobs[0]!);
    expect(firstJob!.job.id).toBe(first.id);
    await startRunner(harness, fixture, firstJob!);
    const conflict = await runnerRequest(harness, fixture, {
      jobId: first.id,
      token: firstJob!.jobToken!,
      report: 'start',
      body: { instanceId: randomUUID(), host: 'node-02', gpuIds: [], phase: 'running' },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'runner_conflict' });
    const otherJob = await runnerRequest(harness, fixture, {
      jobId: first.id,
      token: secondJob!.jobToken!,
      report: 'heartbeat',
      body: { instanceId: randomUUID() },
    });
    expect(otherJob.status).toBe(403);
    expect(second.id).toBe(secondJob!.job.id);
    const withSession = await request(harness.app, `${fixture.basePath}/jobs/${first.id}/runner/heartbeat`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { instanceId: randomUUID() },
    });
    expect(await withSession.json()).toMatchObject({ code: 'runner_token_required' });
  });

  it('待ち行列のJobを取り消すとすぐ終わり、launcherが待ち行列から外す', async () => {
    const fixture = await siteFixture(harness);
    const job = await fixture.newSiteJob();
    await fixture.claim();
    await fixture.report([job.id], { outcome: 'submitted', schedulerJobId: '777' });
    const canceled = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(canceled.status).toBe('canceled');
    expect(await findRunStatus(harness, job.runId)).toBe('canceled');
    const cancellations = await entity<{ items: SiteSchedulerCancellation[] }>(
      await request(harness.app, '/api/launcher/site-submissions/cancellations', {
        method: 'POST',
        token: fixture.launcherToken,
        body: {},
      }),
      200,
    );
    // The cancel command runs as the account that queued the Job.
    expect(cancellations.items).toEqual([
      {
        jobId: job.id,
        targetId: fixture.site.id,
        schedulerJobId: '777',
        account: expect.objectContaining({ mode: 'shared', accountName: 'mmt' }),
      },
    ]);
    expect(
      (
        await request(harness.app, '/api/launcher/site-submissions/cancellations/report', {
          method: 'POST',
          token: fixture.launcherToken,
          body: { jobIds: [job.id] },
        })
      ).status,
    ).toBe(204);
    const after = await entity<{ items: SiteSchedulerCancellation[] }>(
      await request(harness.app, '/api/launcher/site-submissions/cancellations', {
        method: 'POST',
        token: fixture.launcherToken,
        body: {},
      }),
      200,
    );
    expect(after.items).toEqual([]);
  });

  it('担当のlauncherを変えると、待ち行列からの取消は新しいlauncherが自分の鍵で受け持つ', async () => {
    const fixture = await siteFixture(harness);
    const job = await fixture.newSiteJob();
    await fixture.claim();
    await fixture.report([job.id], { outcome: 'submitted', schedulerJobId: '778' });
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    const next = await fixture.newLauncher('launcher-2');
    await entity(
      await request(harness.app, `/api/targets/${fixture.site.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { site: { launcherId: next.launcher.id } },
      }),
      200,
    );
    const pendingFor = async (token: string) =>
      (
        await entity<{ items: SiteSchedulerCancellation[] }>(
          await request(harness.app, '/api/launcher/site-submissions/cancellations', {
            method: 'POST',
            token,
            body: {},
          }),
          200,
        )
      ).items;
    const reportDone = (token: string) =>
      request(harness.app, '/api/launcher/site-submissions/cancellations/report', {
        method: 'POST',
        token,
        body: { jobIds: [job.id] },
      });
    expect(await pendingFor(fixture.launcherToken)).toEqual([]);
    const [key] = await fixture.publishKeys(next.token);
    expect(await pendingFor(next.token)).toEqual([
      {
        jobId: job.id,
        targetId: fixture.site.id,
        schedulerJobId: '778',
        account: expect.objectContaining({ accountName: 'mmt', keyId: key!.id }),
      },
    ]);
    // The launcher that queued it no longer submits there, so its report changes nothing.
    expect((await reportDone(fixture.launcherToken)).status).toBe(204);
    expect(await pendingFor(next.token)).toHaveLength(1);
    expect((await reportDone(next.token)).status).toBe(204);
    expect(await pendingFor(next.token)).toEqual([]);
  });

  it('job shellの失敗はsubmit_failedで終わり、他のlauncherのJobは報告できない', async () => {
    const fixture = await siteFixture(harness);
    const job = await fixture.newSiteJob();
    await fixture.claim();
    const other = await fixture.newLauncher('launcher-2');
    const foreign = await fixture.report([job.id], { outcome: 'submitted' }, other.token);
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toMatchObject({ code: 'invalid_submission' });
    const failed = await entity<{ items: Job[] }>(
      await fixture.report([job.id], { outcome: 'failed', error: 'qsub: Unknown queue' }),
      200,
    );
    expect(failed.items[0]).toMatchObject({
      status: 'failed',
      endReason: 'submit_failed',
      error: 'qsub: Unknown queue',
    });
    expect(await findRunStatus(harness, job.runId)).toBe('failed');
  });

  it('手動投入のsiteでは本人のAPI tokenで自分のJobだけを受け取る', async () => {
    const fixture = await siteFixture(harness, { submissionMode: 'manual' });
    const job = await fixture.newSiteJob();
    expect(job.phase).toBe('waiting_manual');
    expect(await fixture.claim()).toEqual([]);
    const withSession = await request(harness.app, '/api/manual-submissions/claim', {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { targetId: fixture.site.id, submitterId: 'laptop' },
    });
    expect(withSession.status).toBe(403);
    expect(await withSession.json()).toMatchObject({ code: 'api_token_required' });
    const waiting = await entity<{ items: ManualSubmissionWaiting[] }>(
      await request(harness.app, '/api/manual-submissions', { token: fixture.personalToken }),
      200,
    );
    expect(waiting.items).toEqual([
      { targetId: fixture.site.id, targetName: fixture.site.name, waitingJobs: 1, allWaitingJobs: null },
    ]);
    const claimed = await entity<{ items: SiteSubmission[] }>(
      await request(harness.app, '/api/manual-submissions/claim', {
        method: 'POST',
        token: fixture.personalToken,
        body: { targetId: fixture.site.id, submitterId: 'laptop' },
      }),
      200,
    );
    expect(claimed.items).toHaveLength(1);
    expect(claimed.items[0]!.jobs[0]!.job).toMatchObject({ id: job.id, phase: 'submitting' });
    // The submitter runs the site's job shell as themselves, with the site's work directory.
    expect(claimed.items[0]).toMatchObject({
      jobShell: { version: 1, content: TEST_JOB_SHELL },
      account: { mode: 'personal', accountName: '', workDirectory: '/work/mmt', keyId: null },
    });
    expect(claimed.items[0]!.jobs[0]!.job.siteJobShellId).toBe(claimed.items[0]!.jobShell.id);
    const reported = await entity<{ items: Job[] }>(
      await request(harness.app, '/api/manual-submissions/report', {
        method: 'POST',
        token: fixture.personalToken,
        body: {
          submitterId: 'laptop',
          results: [{ jobIds: [job.id], outcome: 'submitted', schedulerJobId: '42' }],
        },
      }),
      200,
    );
    expect(reported.items[0]).toMatchObject({ phase: 'submitted', schedulerJobId: '42' });
  });

  it('arrayは番号ごとのRunとJobを作り、arrayに対応するsiteでは1つの投入にまとめる', async () => {
    const fixture = await siteFixture(harness, { supportsArray: true });
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
          gpuCount: 1,
          size: 3,
        },
      }),
    );
    expect(created.arrayGroup).toMatchObject({ size: 3, targetId: fixture.site.id });
    expect(created.jobs.map((job) => [job.arrayIndex, job.arraySize])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${created.jobs[1]!.runId}`, {
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(run.tags).toMatchObject({
      'mmt.arrayGroupId': created.arrayGroup.id,
      'mmt.arrayIndex': '1',
    });
    const submissions = await fixture.claim();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.arrayGroupId).toBe(created.arrayGroup.id);
    expect(submissions[0]!.jobs.map((workerJob) => workerJob.job.arrayIndex)).toEqual([0, 1, 2]);
    const described = await entity<JobArrayCreated>(
      await request(harness.app, `${fixture.basePath}/job-arrays/${created.arrayGroup.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(described.jobs.every((job) => job.phase === 'submitting')).toBe(true);
    const onLocal = await request(harness.app, `${fixture.basePath}/job-arrays`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        experimentId: fixture.experiment.id,
        name: 'On local',
        kind: 'inference',
        codeVersionId: fixture.containerCodeVersion.id,
        modelVersionId: fixture.modelVersion.id,
        targetId: fixture.target.id,
        size: 2,
      },
    });
    expect(await onLocal.json()).toMatchObject({ code: 'site_target_required' });
  });

  it('arrayに対応しないsiteでは番号ごとに投入し、同時投入数を守る', async () => {
    const fixture = await siteFixture(harness, { maxConcurrentJobs: 2 });
    await entity<JobArrayCreated>(
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
          size: 3,
        },
      }),
    );
    const submissions = await fixture.claim();
    expect(submissions.map((submission) => submission.jobs.length)).toEqual([1, 1]);
    expect(await fixture.claim()).toEqual([]);
  });

  it('制限時間で止まったJobはretryOnTimeoutなら同じ設定で再実行される', async () => {
    const fixture = await siteFixture(harness);
    const job = await fixture.newSiteJob({ retryOnTimeout: true, walltimeSeconds: 600 });
    const [submission] = await fixture.claim();
    await fixture.report([job.id], { outcome: 'submitted', schedulerJobId: '1' });
    const { instanceId } = await startRunner(harness, fixture, submission!.jobs[0]!);
    const finished = await entity<RunnerFinishResult>(
      await runnerRequest(harness, fixture, {
        jobId: job.id,
        token: submission!.jobs[0]!.jobToken!,
        report: 'finish',
        body: { instanceId, status: 'failed', endReason: 'timed_out', error: 'walltime' },
      }),
      200,
    );
    expect(finished.job).toMatchObject({ status: 'failed', endReason: 'timed_out' });
    expect(finished.retryJobId).not.toBeNull();
    const { rows } = await harness.database.query<{
      attempt: number;
      gpu_count: number;
      walltime_seconds: number;
      retry_on_timeout: boolean;
      phase: string | null;
    }>('SELECT attempt,gpu_count,walltime_seconds,retry_on_timeout,phase FROM jobs WHERE id=$1', [
      finished.retryJobId,
    ]);
    expect(rows[0]).toEqual({
      attempt: 2,
      gpu_count: 1,
      walltime_seconds: 600,
      retry_on_timeout: true,
      phase: null,
    });
  });

  it('待ち行列の上限時間を過ぎたJobと、結果が報告されない投入は監視で失敗になる', async () => {
    const fixture = await siteFixture(harness, { queueTimeoutSeconds: 60 });
    const queued = await fixture.newSiteJob();
    const lost = await fixture.newSiteJob();
    await fixture.claim();
    await fixture.report([queued.id], { outcome: 'submitted', schedulerJobId: '9' });
    await harness.database.query(
      "UPDATE jobs SET submitted_at=now()-interval '2 minutes' WHERE id=$1",
      [queued.id],
    );
    await harness.database.query(
      "UPDATE jobs SET heartbeat_at=now()-interval '16 minutes' WHERE id=$1",
      [lost.id],
    );
    expect(await harness.siteJobMonitor.check()).toBe(2);
    const { rows } = await harness.database.query<{
      id: string;
      status: string;
      end_reason: string;
      scheduler_cancel_state: string | null;
    }>('SELECT id,status,end_reason,scheduler_cancel_state FROM jobs ORDER BY created_at');
    expect(rows).toEqual([
      { id: queued.id, status: 'failed', end_reason: 'queue_timeout', scheduler_cancel_state: 'pending' },
      { id: lost.id, status: 'failed', end_reason: 'submit_failed', scheduler_cancel_state: null },
    ]);
    const target = await entity<{ items: ComputeTarget[] }>(
      await request(harness.app, '/api/targets', { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(target.items.find((item) => item.id === fixture.site.id)?.queueTimeoutSeconds).toBe(60);
  });
});
