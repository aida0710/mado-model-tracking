import { createHash } from 'node:crypto';
import type {
  Artifact,
  Code,
  CodeVersion,
  Job,
  Run,
  RunCheckpoint,
  RunCheckpointPage,
  RunKind,
  TaskExecution,
  ExperimentTask,
  WorkerJob,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executionFixture, projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

type Fixture = Awaited<ReturnType<typeof executionFixture>>;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe.skipIf(!testDatabaseUrl)('学習の途中再開（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await executionFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function trainingRun(
    options: { kind?: RunKind; codeVersionId?: string; resumeCheckpointId?: string } = {},
  ): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Training',
          kind: options.kind ?? 'training',
          codeVersionId: options.codeVersionId ?? fixture.codeVersion.id,
          ...(options.resumeCheckpointId ? { resumeCheckpointId: options.resumeCheckpointId } : {}),
        },
      }),
    );
  }

  async function startJob(run: Run): Promise<{ job: Job; workerJob: WorkerJob }> {
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, maxAttempts: 3 },
      }),
    );
    const workerJob = await claim();
    expect(workerJob.job.id).toBe(job.id);
    return { job, workerJob };
  }

  async function claim(): Promise<WorkerJob> {
    return (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'checkpoint-worker' },
        }),
        200,
      )
    ).item;
  }

  async function failJob(workerJob: WorkerJob): Promise<void> {
    await entity<Job>(
      await request(harness.app, `/api/worker/jobs/${workerJob.job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: workerJob.job.leaseId, status: 'failed', exitCode: 1, error: 'OOM' },
      }),
      200,
    );
  }

  async function saveArtifact(
    runId: string,
    options: { path?: string; content?: string; basePath?: string; cookie?: string } = {},
  ): Promise<Artifact> {
    const content = options.content ?? 'checkpoint tar';
    return entity<Artifact>(
      await request(
        harness.app,
        `${options.basePath ?? fixture.basePath}/runs/${runId}/artifacts?path=${options.path ?? 'checkpoints/step.tar'}`,
        {
          method: 'PUT',
          cookie: options.cookie ?? fixture.editor.cookie,
          binary: content,
          headers: { 'Content-Type': 'application/x-tar' },
        },
      ),
    );
  }

  function registerCheckpoint(
    runId: string,
    body: { step: number; artifactId: string },
    auth: { cookie?: string; token?: string } = { cookie: fixture.editor.cookie },
  ) {
    return request(harness.app, `${fixture.basePath}/runs/${runId}/checkpoints`, {
      method: 'POST',
      ...auth,
      body: {
        ...body,
        manifest: {
          files: [{ path: 'model.pt', sha256: sha256('weights'), size: 7 }],
          includesOptimizer: true,
          framework: 'torch',
        },
        metadata: { epoch: 1 },
      },
    });
  }

  async function checkpointAt(runId: string, step: number): Promise<RunCheckpoint> {
    const artifact = await saveArtifact(runId, { path: `checkpoints/step-${step}.tar` });
    return entity<RunCheckpoint>(await registerCheckpoint(runId, { step, artifactId: artifact.id }));
  }

  async function listCheckpoints(runId: string, includeHidden = false): Promise<RunCheckpoint[]> {
    return (
      await entity<RunCheckpointPage>(
        await request(
          harness.app,
          `${fixture.basePath}/runs/${runId}/checkpoints${includeHidden ? '?includeHidden=true' : ''}`,
          { cookie: fixture.viewer.cookie },
        ),
        200,
      )
    ).items;
  }

  function retry(jobId: string, body?: unknown) {
    return request(harness.app, `${fixture.basePath}/jobs/${jobId}/retry`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      ...(body === undefined ? {} : { body }),
    });
  }

  async function errorCode(response: Response): Promise<string | undefined> {
    return ((await response.json()) as { code?: string }).code;
  }

  // A running training Run that saved checkpoints, then failed.
  async function failedTrainingWithCheckpoints(steps: number[]) {
    const run = await trainingRun();
    const { workerJob } = await startJob(run);
    const checkpoints = [];
    for (const step of steps) checkpoints.push(await checkpointAt(run.id, step));
    await failJob(workerJob);
    return { run, job: workerJob.job, checkpoints };
  }

  it('checkpointを登録するとArtifact・manifest・サイズ付きで一覧に出る', async () => {
    const run = await trainingRun();
    const checkpoint = await checkpointAt(run.id, 100);
    expect(checkpoint).toMatchObject({
      runId: run.id,
      step: 100,
      source: 'native',
      retained: true,
      totalSize: 'checkpoint tar'.length,
      manifest: { includesOptimizer: true, framework: 'torch' },
      metadata: { epoch: 1 },
    });
    expect(checkpoint.artifacts).toEqual([
      expect.objectContaining({ id: checkpoint.artifactIds[0], sha256: sha256('checkpoint tar') }),
    ]);
    expect(await listCheckpoints(run.id)).toEqual([checkpoint]);
  });

  it('同じRunとstepの二重登録は409で、バージョンは更新も削除もできない', async () => {
    const run = await trainingRun();
    const checkpoint = await checkpointAt(run.id, 5);
    const artifact = await saveArtifact(run.id, { path: 'checkpoints/again.tar' });
    const duplicate = await registerCheckpoint(run.id, { step: 5, artifactId: artifact.id });
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe('checkpoint_exists');
    for (const statement of [
      'UPDATE run_checkpoints SET step=6 WHERE id=$1',
      `UPDATE run_checkpoints SET metadata='{"changed":true}' WHERE id=$1`,
      `UPDATE run_checkpoints SET manifest='{"files":[]}' WHERE id=$1`,
      'DELETE FROM run_checkpoints WHERE id=$1',
    ])
      await expect(harness.database.query(statement, [checkpoint.id])).rejects.toMatchObject({
        code: '23514',
      });
  });

  it('別ProjectのArtifactやRunは404、別RunのArtifactと推論Runへの登録は422', async () => {
    const run = await trainingRun();
    const other = await projectFixture(harness);
    const otherCode = await entity<Code>(
      await request(harness.app, `${other.basePath}/codes`, {
        method: 'POST',
        cookie: other.editor.cookie,
        body: { name: 'Other' },
      }),
    );
    expect(otherCode.projectId).toBe(other.project.id);
    const otherRun = await entity<Run>(
      await request(harness.app, `${other.basePath}/runs`, {
        method: 'POST',
        cookie: other.editor.cookie,
        body: { experimentId: other.experiment.id, name: 'Other', kind: 'training' },
      }),
    );
    const foreignArtifact = await saveArtifact(otherRun.id, {
      basePath: other.basePath,
      cookie: other.editor.cookie,
    });
    expect(
      (await registerCheckpoint(run.id, { step: 1, artifactId: foreignArtifact.id })).status,
    ).toBe(404);
    const ownArtifact = await saveArtifact(run.id);
    expect(
      (await registerCheckpoint(otherRun.id, { step: 1, artifactId: ownArtifact.id })).status,
    ).toBe(404);
    const sibling = await trainingRun();
    const siblingResponse = await registerCheckpoint(sibling.id, {
      step: 1,
      artifactId: ownArtifact.id,
    });
    expect(siblingResponse.status).toBe(422);
    expect(await errorCode(siblingResponse)).toBe('checkpoint_artifact_run');
    const inference = await fixture.newRun('Inference', 'inference');
    const inferenceArtifact = await saveArtifact(inference.id);
    const inferenceResponse = await registerCheckpoint(inference.id, {
      step: 1,
      artifactId: inferenceArtifact.id,
    });
    expect(inferenceResponse.status).toBe(422);
    expect(await errorCode(inferenceResponse)).toBe('checkpoint_run_kind');
    expect((await registerCheckpoint(run.id, { step: 1, artifactId: ownArtifact.id }, { cookie: fixture.viewer.cookie })).status).toBe(403);
  });

  it('Job tokenは自分のRunにだけ、worker tokenは保持中のJobのRunにだけ登録できる', async () => {
    const run = await trainingRun();
    const { workerJob } = await startJob(run);
    const artifact = await saveArtifact(run.id);
    const other = await trainingRun();
    const otherArtifact = await saveArtifact(other.id);
    expect(
      (await registerCheckpoint(other.id, { step: 1, artifactId: otherArtifact.id }, { token: workerJob.jobToken! })).status,
    ).toBe(403);
    expect(
      (await registerCheckpoint(other.id, { step: 1, artifactId: otherArtifact.id }, { token: fixture.workerToken })).status,
    ).toBe(403);
    expect(
      (await registerCheckpoint(run.id, { step: 1, artifactId: artifact.id }, { token: workerJob.jobToken! })).status,
    ).toBe(201);
    expect(
      (await registerCheckpoint(run.id, { step: 2, artifactId: artifact.id }, { token: fixture.workerToken })).status,
    ).toBe(201);
  });

  it('保持数を超えた古いcheckpointはretained=falseで既定の一覧から外れ、Artifactは残る', async () => {
    const run = await trainingRun();
    const checkpoints = [];
    for (let step = 1; step <= harness.config.checkpointKeepCount + 2; step++)
      checkpoints.push(await checkpointAt(run.id, step * 10));
    const listed = await listCheckpoints(run.id);
    expect(listed.map((checkpoint) => checkpoint.step)).toEqual(
      checkpoints
        .slice(2)
        .map((checkpoint) => checkpoint.step)
        .reverse(),
    );
    const all = await listCheckpoints(run.id, true);
    expect(all).toHaveLength(checkpoints.length);
    expect(all.filter((checkpoint) => !checkpoint.retained).map((checkpoint) => checkpoint.step)).toEqual([20, 10]);
    const hiddenArtifact = await request(
      harness.app,
      `${fixture.basePath}/artifacts/${checkpoints[0]!.artifactIds[0]}/content`,
      { cookie: fixture.viewer.cookie },
    );
    expect(hiddenArtifact.status).toBe(200);
  });

  it('retry+checkpointIdで新Runにresume_checkpoint_idとenvironment.resumeが固定され、Job開始後は変えられない', async () => {
    const { run, job, checkpoints } = await failedTrainingWithCheckpoints([10, 20]);
    const chosen = checkpoints[0]!;
    const retried = await entity<{ run: Run; job: Job }>(await retry(job.id, { checkpointId: chosen.id }));
    expect(retried.run).toMatchObject({
      resumeCheckpointId: chosen.id,
      parentRunId: run.id,
      environment: { resume: { checkpointId: chosen.id, sourceRunId: run.id, step: 10 } },
    });
    // The original Run is evidence and stays unchanged.
    const original = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(original).toMatchObject({ status: 'failed', resumeCheckpointId: null });
    // While queued an environment edit cannot drop or forge environment.resume.
    const patched = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${retried.run.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { environment: { resume: { checkpointId: checkpoints[1]!.id }, note: 'x' } },
      }),
      200,
    );
    expect(patched.environment).toMatchObject({ note: 'x', resume: { checkpointId: chosen.id, step: 10 } });
    const workerJob = await claim();
    expect(workerJob.run.id).toBe(retried.run.id);
    expect(workerJob.resumeCheckpoint).toMatchObject({
      id: chosen.id,
      runId: run.id,
      step: 10,
      source: 'native',
      artifacts: [expect.objectContaining({ id: chosen.artifactIds[0], sha256: chosen.artifacts[0]!.sha256 })],
      manifest: chosen.manifest,
    });
    const afterStart = await request(harness.app, `${fixture.basePath}/runs/${retried.run.id}`, {
      method: 'PATCH',
      cookie: fixture.editor.cookie,
      body: { environment: {} },
    });
    expect(afterStart.status).toBe(409);
    await expect(
      harness.database.query('UPDATE runs SET resume_checkpoint_id=$2 WHERE id=$1', [
        retried.run.id,
        checkpoints[1]!.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.database.query('UPDATE runs SET resume_checkpoint_id=NULL WHERE id=$1', [retried.run.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('resumeFromLatestCheckpointは最大stepを選び、再送は同じRunを返し、別のcheckpoint指定は409', async () => {
    const { job, checkpoints } = await failedTrainingWithCheckpoints([30, 10, 20]);
    const latest = await entity<{ run: Run; job: Job }>(
      await retry(job.id, { resumeFromLatestCheckpoint: true }),
    );
    expect(latest.run.resumeCheckpointId).toBe(checkpoints[0]!.id);
    expect(latest.run.environment).toMatchObject({ resume: { step: 30 } });
    const resent = await entity<{ run: Run; job: Job }>(
      await retry(job.id, { resumeFromLatestCheckpoint: true }),
    );
    expect(resent.run.id).toBe(latest.run.id);
    const different = await retry(job.id, { checkpointId: checkpoints[1]!.id });
    expect(different.status).toBe(409);
    expect(await errorCode(different)).toBe('job_already_retried');
    // A body-less retry (older clients) still returns the existing retry.
    expect((await entity<{ run: Run }>(await retry(job.id))).run.id).toBe(latest.run.id);
  });

  it('checkpointの無いRunの最新からの再開は422、本文なしのretryは最初から', async () => {
    const run = await trainingRun();
    const { workerJob } = await startJob(run);
    await failJob(workerJob);
    const missing = await retry(workerJob.job.id, { resumeFromLatestCheckpoint: true });
    expect(missing.status).toBe(422);
    expect(await errorCode(missing)).toBe('checkpoint_not_found');
    const fresh = await entity<{ run: Run }>(await retry(workerJob.job.id));
    expect(fresh.run.resumeCheckpointId).toBeNull();
    expect(fresh.run.environment).not.toHaveProperty('resume');
  });

  it('再開したRunがcheckpointを残さず失敗したら、最新からの再開は同じcheckpointを引き継ぐ', async () => {
    const { job, checkpoints } = await failedTrainingWithCheckpoints([40]);
    const first = await entity<{ run: Run; job: Job }>(
      await retry(job.id, { resumeFromLatestCheckpoint: true }),
    );
    const workerJob = await claim();
    expect(workerJob.job.id).toBe(first.job.id);
    await failJob(workerJob);
    const second = await entity<{ run: Run }>(
      await retry(first.job.id, { resumeFromLatestCheckpoint: true }),
    );
    expect(second.run.resumeCheckpointId).toBe(checkpoints[0]!.id);
  });

  it('推論Run・別Codeのバージョン・別Projectのcheckpointへの指定は拒否する', async () => {
    const { checkpoints } = await failedTrainingWithCheckpoints([10]);
    const checkpointId = checkpoints[0]!.id;
    const inference = await request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        experimentId: fixture.experiment.id,
        name: 'Inference',
        kind: 'inference',
        modelVersionId: fixture.modelVersion.id,
        resumeCheckpointId: checkpointId,
      },
    });
    expect(inference.status).toBe(422);
    expect(await errorCode(inference)).toBe('checkpoint_kind_mismatch');
    const finetuning = await request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        experimentId: fixture.experiment.id,
        name: 'Finetuning',
        kind: 'finetuning',
        codeVersionId: fixture.codeVersion.id,
        resumeCheckpointId: checkpointId,
      },
    });
    expect(finetuning.status).toBe(422);
    const otherCode = await entity<Code>(
      await request(harness.app, `${fixture.basePath}/codes`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Other trainer' },
      }),
    );
    const otherVersion = await entity<CodeVersion>(
      await request(harness.app, `${fixture.basePath}/codes/${otherCode.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v1',
          source: { kind: 'inline', files: { 'main.py': 'print("other")\n' } },
          entrypoint: ['python', 'main.py'],
          supportedModelFamilies: ['qwen2'],
          taskTypes: ['training'],
        },
      }),
    );
    const otherCodeRun = await request(harness.app, `${fixture.basePath}/runs`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        experimentId: fixture.experiment.id,
        name: 'Other code',
        kind: 'training',
        codeVersionId: otherVersion.id,
        resumeCheckpointId: checkpointId,
      },
    });
    expect(otherCodeRun.status).toBe(422);
    expect(await errorCode(otherCodeRun)).toBe('checkpoint_code_mismatch');
    // Another version of the same Code may continue the training.
    const nextVersion = await entity<CodeVersion>(
      await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v2',
          source: { kind: 'inline', files: { 'main.py': 'print("v2")\n' } },
          entrypoint: ['python', 'main.py'],
          supportedModelFamilies: ['qwen2'],
          taskTypes: ['training'],
        },
      }),
    );
    const continued = await trainingRun({
      codeVersionId: nextVersion.id,
      resumeCheckpointId: checkpointId,
    });
    expect(continued.resumeCheckpointId).toBe(checkpointId);
    // Another Project cannot see the checkpoint at all.
    const other = await projectFixture(harness);
    const foreign = await request(harness.app, `${other.basePath}/runs`, {
      method: 'POST',
      cookie: other.editor.cookie,
      body: {
        experimentId: other.experiment.id,
        name: 'Foreign',
        kind: 'training',
        resumeCheckpointId: checkpointId,
      },
    });
    expect(foreign.status).toBe(404);
  });

  it('Task launchのresumeCheckpointIdでも新Runが固定される', async () => {
    const { run, checkpoints } = await failedTrainingWithCheckpoints([7]);
    const task = await entity<ExperimentTask>(
      await request(harness.app, `${fixture.basePath}/tasks`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Train',
          kind: 'training',
          codeVersionId: fixture.codeVersion.id,
          targetId: fixture.target.id,
        },
      }),
    );
    const launched = await entity<TaskExecution>(
      await request(harness.app, `${fixture.basePath}/tasks/${task.id}/launch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: task.revision, resumeCheckpointId: checkpoints[0]!.id },
      }),
    );
    expect(launched.run).toMatchObject({
      resumeCheckpointId: checkpoints[0]!.id,
      parentRunId: run.id,
      environment: { resume: { step: 7, sourceRunId: run.id } },
    });
  });

  it('MLflowのcheckpoints/step-N/は自動でcheckpointになり、Run終了後の追加は409', async () => {
    // A Run without a Job, as an MLflow script reports it; it stays writable after it ends.
    const run = await trainingRun();
    const setStatus = async (status: string) =>
      entity<Run>(
        await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status },
        }),
        200,
      );
    await setStatus('running');
    const mlflowPut = (path: string, content: string) =>
      request(
        harness.app,
        `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow-artifacts/artifacts/runs/${run.id}/artifacts/${path}`,
        {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: content,
          headers: { 'Content-Type': 'application/octet-stream' },
        },
      );
    expect((await mlflowPut('checkpoints/step-3/model.pt', 'weights')).status).toBe(200);
    expect((await mlflowPut('checkpoints/step-3/optim/state.pt', 'optimizer')).status).toBe(200);
    expect((await mlflowPut('checkpoints/step-3/model.pt', 'weights-2')).status).toBe(200);
    expect((await mlflowPut('checkpoints/latest.txt', '3')).status).toBe(200);
    const [checkpoint, ...rest] = await listCheckpoints(run.id);
    expect(rest).toEqual([]);
    expect(checkpoint).toMatchObject({ step: 3, source: 'mlflow' });
    expect(checkpoint!.manifest.files).toEqual([
      { path: 'optim/state.pt', sha256: sha256('optimizer'), size: 9 },
      { path: 'model.pt', sha256: sha256('weights-2'), size: 9 },
    ]);
    expect(checkpoint!.artifacts.map((artifact) => artifact.path).sort()).toEqual([
      'model.pt',
      'optim/state.pt',
    ]);
    await setStatus('finished');
    expect((await mlflowPut('checkpoints/step-3/extra.pt', 'late')).status).toBe(409);
    expect((await mlflowPut('checkpoints/step-4/model.pt', 'late')).status).toBe(409);
    // Other paths of the ended Run are still writable, as in MLflow.
    expect((await mlflowPut('notes/after.txt', 'note')).status).toBe(200);
    expect((await listCheckpoints(run.id))[0]!.manifest.files).toHaveLength(2);
  });
});
