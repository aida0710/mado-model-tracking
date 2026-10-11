import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job, Run, WorkerJob } from '@mmt/contracts';
import {
  allowWithinProject,
  JOB_TOKEN_READ_RULES,
  JOB_TOKEN_WRITE_RULES,
} from '../src/http/jobTokenGuard.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

type Fixture = Awaited<ReturnType<typeof executionFixture>>;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NOW = '2026-10-08T00:00:00.000Z';

describe.skipIf(!testDatabaseUrl)('Job限定token（独立PostgreSQL）', () => {
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

  async function queueJob(fixture: Fixture, name = 'Training'): Promise<{ run: Run; job: Job }> {
    const run = await fixture.newRun(name, 'training');
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    return { run, job };
  }

  async function claim(fixture: Fixture, workerId = 'token-worker'): Promise<WorkerJob> {
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

  async function resume(fixture: Fixture, workerId = 'token-worker'): Promise<WorkerJob[]> {
    const resumed = await entity<{ items: WorkerJob[] }>(
      await request(harness.app, '/api/worker/resume', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId },
      }),
      200,
    );
    return resumed.items;
  }

  async function startedJob(fixture: Fixture) {
    const queued = await queueJob(fixture);
    const workerJob = await claim(fixture);
    expect(workerJob.job.id).toBe(queued.job.id);
    return { ...queued, workerJob, jobToken: workerJob.jobToken! };
  }

  function nativeMetric(fixture: Fixture, runId: string, token: string) {
    return request(harness.app, `${fixture.basePath}/runs/${runId}/metrics`, {
      method: 'POST',
      token,
      body: { metrics: [{ name: 'loss', value: 0.5, step: 1, timestamp: NOW }] },
    });
  }

  function mlflowBase(fixture: Fixture) {
    return `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow`;
  }

  function mlflowArtifact(fixture: Fixture, owner: string, token: string, body = 'data') {
    return request(
      harness.app,
      `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow-artifacts/artifacts/${owner}/artifacts/output/file.txt`,
      { method: 'PUT', token, binary: body, headers: { 'Content-Type': 'text/plain' } },
    );
  }

  async function errorCode(response: Response): Promise<string> {
    const body = (await response.json()) as { code?: string; error_code?: string };
    return body.code ?? body.error_code ?? '';
  }

  it('claimでmmtj_ tokenを発行し、DBにはhashだけを保存する', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken, run, job } = await startedJob(fixture);
    expect(jobToken).toMatch(/^mmtj_[A-Za-z0-9_-]{43}$/);
    const stored = await harness.database.query('SELECT * FROM job_tokens');
    expect(stored.rows).toHaveLength(1);
    const row = stored.rows[0];
    expect(row.token_hash).toBe(createHash('sha256').update(jobToken).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(jobToken);
    expect(row).toMatchObject({ job_id: job.id, run_id: run.id, user_id: fixture.editor.userId });
  });

  it('自分のRunへnativeのmetrics・Artifact・出力モデル登録ができる', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken, run } = await startedJob(fixture);
    expect((await nativeMetric(fixture, run.id, jobToken)).status).toBe(204);
    const artifact = await request(
      harness.app,
      `${fixture.basePath}/runs/${run.id}/artifacts?path=outputs/result.txt`,
      { method: 'PUT', token: jobToken, binary: 'result', headers: { 'Content-Type': 'text/plain' } },
    );
    expect(artifact.status).toBe(201);
    const version = await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
      method: 'POST',
      token: jobToken,
      body: { sourceRunId: run.id },
    });
    expect(version.status).toBe(201);
    const outputModel = await request(harness.app, `${fixture.basePath}/models`, {
      method: 'POST',
      token: jobToken,
      body: { name: 'Job Output', family: 'qwen2' },
    });
    expect(outputModel.status).toBe(201);
    // Reads stay possible inside the Project, for example upstream Run details.
    expect((await request(harness.app, `${fixture.basePath}/runs/${run.id}`, { token: jobToken })).status).toBe(200);
  });

  it('自分のRunへ再開可能なuploadを作って完了でき、そのsessionは同じJob tokenだけが使える', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken, run } = await startedJob(fixture);
    const content = 'checkpoint';
    const created = await request(harness.app, `${fixture.basePath}/artifact-uploads`, {
      method: 'POST',
      token: jobToken,
      body: { path: 'outputs/checkpoint.bin', runId: run.id, expectedSize: content.length },
    });
    const upload = await entity<{ id: string }>(created, 201);
    const stored = await harness.database.query(
      'SELECT created_by_token_id, created_by_job_token_id FROM artifact_uploads WHERE id=$1',
      [upload.id],
    );
    expect(stored.rows[0].created_by_token_id).toBeNull();
    expect(stored.rows[0].created_by_job_token_id).not.toBeNull();
    const uploadPath = `${fixture.basePath}/artifact-uploads/${upload.id}`;
    // The Run creator's own session did not open it, so it cannot continue the upload.
    const byCreator = await request(harness.app, uploadPath, { cookie: fixture.editor.cookie });
    expect(await errorCode(byCreator)).toBe('upload_forbidden');
    const part = await request(harness.app, `${uploadPath}/parts/1`, {
      method: 'PUT',
      token: jobToken,
      headers: { 'Content-Length': String(content.length) },
      binary: content,
    });
    expect(part.status).toBe(200);
    expect((await request(harness.app, `${uploadPath}/complete`, { method: 'POST', token: jobToken })).status).toBe(202);
    const other = await fixture.newRun('Other Run', 'training');
    const refused = await request(harness.app, `${fixture.basePath}/artifact-uploads`, {
      method: 'POST',
      token: jobToken,
      body: { path: 'outputs/other.bin', runId: other.id, expectedSize: content.length },
    });
    expect(refused.status).toBe(403);
  });

  it('MLflow経路でset-tag・log-batch・Artifact・Logged Model・バージョン登録ができる', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken, run } = await startedJob(fixture);
    const base = mlflowBase(fixture);
    expect(
      (await request(harness.app, `${base}/runs/set-tag`, {
        method: 'POST', token: jobToken, body: { run_id: run.id, key: 'stage', value: 'train' },
      })).status,
    ).toBe(200);
    expect(
      (await request(harness.app, `${base}/runs/log-batch`, {
        method: 'POST', token: jobToken,
        body: { run_id: run.id, metrics: [{ key: 'loss', value: 0.25, timestamp: 1, step: 1 }] },
      })).status,
    ).toBe(200);
    expect((await mlflowArtifact(fixture, `runs/${run.id}`, jobToken)).status).toBe(200);

    const created = await entity<{ model: { info: { model_id: string } } }>(
      await request(harness.app, `${base}/logged-models`, {
        method: 'POST', token: jobToken,
        body: { experiment_id: fixture.experiment.id, source_run_id: run.id, name: 'job-model' },
      }),
      200,
    );
    const modelId = created.model.info.model_id;
    const files = {
      MLmodel: 'flavors:\n  python_function:\n    loader_module: mlflow.sklearn\n    model_path: model.pkl\n',
      'model.pkl': 'weights',
    };
    for (const [path, contents] of Object.entries(files)) {
      const response = await request(
        harness.app,
        `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow-artifacts/artifacts/models/${modelId}/artifacts/${path}`,
        { method: 'PUT', token: jobToken, binary: contents },
      );
      expect(response.status).toBe(200);
    }
    expect(
      (await request(harness.app, `${base}/logged-models/${modelId}`, {
        method: 'PATCH', token: jobToken, body: { model_id: modelId, status: 'LOGGED_MODEL_READY' },
      })).status,
    ).toBe(200);
    expect(
      (await request(harness.app, `${base}/registered-models/create`, {
        method: 'POST', token: jobToken, body: { name: 'Job Registered' },
      })).status,
    ).toBe(200);
    const registered = await request(harness.app, `${base}/model-versions/create`, {
      method: 'POST', token: jobToken,
      body: { name: 'Job Registered', source: `models:/${modelId}`, model_id: modelId, run_id: run.id },
    });
    expect(registered.status).toBe(200);
  });

  it('同じProjectの別Run、worker API、token発行、rule作成、Run作成は403になる', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken } = await startedJob(fixture);
    const other = await fixture.newRun('Other Run', 'training');
    const base = mlflowBase(fixture);
    const refusals: Response[] = [
      await nativeMetric(fixture, other.id, jobToken),
      await request(harness.app, `${base}/runs/set-tag`, {
        method: 'POST', token: jobToken, body: { run_id: other.id, key: 'stage', value: 'x' },
      }),
      await request(harness.app, `${base}/runs/log-batch`, {
        method: 'POST', token: jobToken,
        body: { run_uuid: other.id, metrics: [{ key: 'loss', value: 1, timestamp: 1, step: 1 }] },
      }),
      await mlflowArtifact(fixture, `runs/${other.id}`, jobToken),
      await request(harness.app, `${base}/logged-models`, {
        method: 'POST', token: jobToken,
        body: { experiment_id: fixture.experiment.id, source_run_id: other.id },
      }),
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST', token: jobToken, body: { sourceRunId: other.id },
      }),
      await request(harness.app, `${base}/model-versions/create`, {
        method: 'POST', token: jobToken,
        body: { name: 'Qwen2 Test', source: `runs:/${other.id}/model`, run_id: other.id },
      }),
      await request(harness.app, '/api/worker/claim', {
        method: 'POST', token: jobToken, body: { workerId: 'job-code' },
      }),
      await request(harness.app, '/api/tokens', {
        method: 'POST', token: jobToken,
        body: { name: 'escalate', kind: 'personal', projectId: fixture.project.id, scopes: ['read'] },
      }),
      await request(harness.app, `${fixture.basePath}/automation-rules`, {
        method: 'POST', token: jobToken,
        body: {
          name: 'rule', modelFamilies: ['qwen2'], kind: 'inference', experimentId: fixture.experiment.id,
          codeVersionId: fixture.codeVersion.id, targetId: fixture.target.id, maxAttempts: 1,
        },
      }),
      await request(harness.app, `${base}/runs/create`, {
        method: 'POST', token: jobToken, body: { experiment_id: fixture.experiment.id },
      }),
    ];
    for (const response of refusals) {
      expect(response.status).toBe(403);
      expect(['job_token_forbidden', 'PERMISSION_DENIED']).toContain(await errorCode(response));
    }
    const metrics = await harness.database.query('SELECT 1 FROM metrics WHERE run_id=$1', [other.id]);
    expect(metrics.rows).toHaveLength(0);
  });

  it('他Projectの読み出しも403になる', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken } = await startedJob(fixture);
    const response = await request(harness.app, `/api/projects/${randomUUID()}/runs`, { token: jobToken });
    expect(response.status).toBe(403);
    expect((await request(harness.app, '/api/auth/me', { token: jobToken })).status).toBe(403);
  });

  it('GET /auth/tokenはJob token自身をjob=trueで返す', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken } = await startedJob(fixture);
    const current = await entity<{ projectId: string; job: boolean; scopes: string[] }>(
      await request(harness.app, '/api/auth/token', { token: jobToken }),
      200,
    );
    expect(current).toMatchObject({ projectId: fixture.project.id, job: true });
    expect(current.scopes).toEqual(['read', 'runs:write', 'artifacts:write', 'registry:write']);
    // Other routes outside a Project stay closed.
    expect((await request(harness.app, '/api/auth/me', { token: jobToken })).status).toBe(403);
    expect((await request(harness.app, '/api/projects', { token: jobToken })).status).toBe(403);
  });

  it('書き込みrouteは許可表にないものを全て拒否する', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken } = await startedJob(fixture);
    const unconditional = new Set(
      [...JOB_TOKEN_WRITE_RULES, ...JOB_TOKEN_READ_RULES]
        .filter((rule) => rule.allows === allowWithinProject)
        .flatMap((rule) => rule.methods.map((method) => `${method} ${rule.route}`)),
    );
    const routes = new Map<string, { method: string; path: string }>();
    for (const route of harness.app.routes)
      if (WRITE_METHODS.has(route.method)) routes.set(`${route.method} ${route.path}`, route);
    expect(routes.size).toBeGreaterThan(50);
    const checked: string[] = [];
    for (const [key, route] of routes) {
      if (unconditional.has(key)) continue;
      // Foreign ids: rules that check the Run, upload, or Logged Model must refuse them.
      const path = route.path
        .replace(':p', fixture.project.id)
        .replace(/:model_id/g, `m-${'0'.repeat(32)}`)
        .replace(/:[A-Za-z_]+/g, () => randomUUID())
        .replace(/\*$/, `runs/${randomUUID()}/artifacts/file.txt`);
      const response = await request(harness.app, path, {
        method: route.method,
        token: jobToken,
        body: { run_id: randomUUID(), runId: randomUUID(), sourceRunId: randomUUID() },
      });
      expect(response.status, key).toBe(403);
      expect(['job_token_forbidden', 'PERMISSION_DENIED'], key).toContain(await errorCode(response));
      checked.push(key);
    }
    expect(checked).toContain('POST /api/worker/claim');
    expect(checked).toContain('POST /api/tokens');
  });

  it('Jobが終わると401になり、cancelして完了しても401になる', async () => {
    const fixture = await executionFixture(harness);
    const finished = await startedJob(fixture);
    await entity(
      await request(harness.app, `/api/worker/jobs/${finished.job.id}/complete`, {
        method: 'POST', token: fixture.workerToken,
        body: { leaseId: finished.workerJob.job.leaseId, status: 'finished', exitCode: 0 },
      }),
      200,
    );
    const afterFinish = await nativeMetric(fixture, finished.run.id, finished.jobToken);
    expect(afterFinish.status).toBe(401);

    const canceled = await startedJob(fixture);
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${canceled.job.id}/cancel`, {
        method: 'POST', cookie: fixture.editor.cookie,
      }),
      200,
    );
    await entity(
      await request(harness.app, `/api/worker/jobs/${canceled.job.id}/complete`, {
        method: 'POST', token: fixture.workerToken,
        body: { leaseId: canceled.workerJob.job.leaseId, status: 'canceled' },
      }),
      200,
    );
    expect((await nativeMetric(fixture, canceled.run.id, canceled.jobToken)).status).toBe(401);
    expect((await mlflowArtifact(fixture, `runs/${canceled.run.id}`, canceled.jobToken)).status).toBe(401);
  });

  it('Run作成者の権限が下がるか外されると403になる', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken, run } = await startedJob(fixture);
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${fixture.editor.userId}`, {
        method: 'PUT', cookie: fixture.administrator.cookie, body: { role: 'viewer' },
      }),
      200,
    );
    expect((await nativeMetric(fixture, run.id, jobToken)).status).toBe(403);
    expect((await request(harness.app, `${fixture.basePath}/runs/${run.id}`, { token: jobToken })).status).toBe(200);
    await harness.database.query('DELETE FROM project_members WHERE user_id=$1', [fixture.editor.userId]);
    expect((await request(harness.app, `${fixture.basePath}/runs/${run.id}`, { token: jobToken })).status).toBe(403);
  });

  it('claim応答が失われて再claimすると旧tokenは401、新tokenは使える', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken: lostToken, run, job } = await startedJob(fixture);
    const reclaimed = await claim(fixture);
    expect(reclaimed.job.id).toBe(job.id);
    expect(reclaimed.jobToken).toMatch(/^mmtj_/);
    expect(reclaimed.jobToken).not.toBe(lostToken);
    expect((await nativeMetric(fixture, run.id, lostToken)).status).toBe(401);
    expect((await nativeMetric(fixture, run.id, reclaimed.jobToken!)).status).toBe(204);
  });

  it('runningのJobのresumeはjobTokenをnullで返し、既存tokenは使い続けられる', async () => {
    const fixture = await executionFixture(harness);
    const { jobToken, run, job, workerJob } = await startedJob(fixture);
    await entity(
      await request(harness.app, `/api/worker/jobs/${job.id}/heartbeat`, {
        method: 'POST', token: fixture.workerToken,
        body: { leaseId: workerJob.job.leaseId, status: 'running' },
      }),
      200,
    );
    const resumed = await resume(fixture);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.jobToken).toBeNull();
    expect((await nativeMetric(fixture, run.id, jobToken)).status).toBe(204);
    const issued = await harness.database.query('SELECT 1 FROM job_tokens WHERE job_id=$1', [job.id]);
    expect(issued.rows).toHaveLength(1);
  });
});
