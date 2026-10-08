import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job, TokenSummary, WorkerJob } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture, projectFixture } from './fixtures.js';

type ProjectFixture = Awaited<ReturnType<typeof projectFixture>>;

// What the MLflow SDK sends when MLFLOW_TRACKING_USERNAME and MLFLOW_TRACKING_PASSWORD are set.
function basic(password: string, username = 'any-user'): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

describe.skipIf(!testDatabaseUrl)('MLflow互換APIのBasic認証（独立PostgreSQL）', () => {
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

  function mlflowPath(fixture: ProjectFixture, endpoint: string): string {
    return `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow${endpoint}`;
  }

  async function personalToken(
    fixture: ProjectFixture,
    scopes: string[],
  ): Promise<{ token: string; item: TokenSummary }> {
    return entity(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: scopes.join(' '), kind: 'personal', projectId: fixture.project.id, scopes },
      }),
    );
  }

  function searchExperiments(fixture: ProjectFixture, headers: Record<string, string>) {
    return request(harness.app, mlflowPath(fixture, '/experiments/search'), {
      method: 'POST',
      headers,
      body: { max_results: 10 },
    });
  }

  function createRun(fixture: ProjectFixture, headers: Record<string, string>) {
    return request(harness.app, mlflowPath(fixture, '/runs/create'), {
      method: 'POST',
      headers,
      body: { experiment_id: fixture.experiment.id, run_name: 'basic' },
    });
  }

  async function mlflowErrorCode(response: Response): Promise<string> {
    return ((await response.json()) as { error_code: string }).error_code;
  }

  it('passwordにAPI tokenを入れたBasic認証で読み書きでき、usernameは照合しない', async () => {
    const fixture = await projectFixture(harness);
    const { token } = await personalToken(fixture, ['read', 'runs:write']);
    const searched = await searchExperiments(fixture, basic(token));
    expect(searched.status).toBe(200);
    expect(
      ((await searched.json()) as { experiments: { name: string }[] }).experiments.map(
        (experiment) => experiment.name,
      ),
    ).toContain('Test Experiment');
    expect((await createRun(fixture, basic(token, ''))).status).toBe(200);
    expect((await createRun(fixture, basic(token, 'someone-else@example.test'))).status).toBe(200);
  });

  it('失効したtokenは401、scopeが足りなければ403になる', async () => {
    const fixture = await projectFixture(harness);
    const reader = await personalToken(fixture, ['read']);
    const refused = await createRun(fixture, basic(reader.token));
    expect(refused.status).toBe(403);
    expect(await mlflowErrorCode(refused)).toBe('PERMISSION_DENIED');
    await request(harness.app, `/api/tokens/${reader.item.id}`, {
      method: 'DELETE',
      cookie: fixture.editor.cookie,
    });
    const revoked = await searchExperiments(fixture, basic(reader.token));
    expect(revoked.status).toBe(401);
    expect(await mlflowErrorCode(revoked)).toBe('UNAUTHENTICATED');
  });

  it('passwordがtokenの形式でなければ、ローカルアカウントのpasswordでも401になる', async () => {
    const fixture = await projectFixture(harness);
    for (const headers of [
      basic('correct horse battery staple', 'admin'),
      basic('mmt_'),
      { Authorization: `Basic ${Buffer.from('no-separator').toString('base64')}` },
      { Authorization: 'Basic !!!' },
    ]) {
      const response = await searchExperiments(fixture, headers);
      expect(response.status).toBe(401);
      expect(await mlflowErrorCode(response)).toBe('UNAUTHENTICATED');
    }
  });

  it('Job限定tokenをBasicで送っても、Job tokenの許可表がそのまま効く', async () => {
    const fixture = await executionFixture(harness);
    const run = await fixture.newRun('Training', 'training');
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const claimed = await entity<{ item: WorkerJob }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'basic-worker' },
      }),
      200,
    );
    const jobToken = claimed.item.jobToken!;
    const ownRun = await request(harness.app, mlflowPath(fixture, '/runs/log-metric'), {
      method: 'POST',
      headers: basic(jobToken),
      body: { run_id: run.id, key: 'loss', value: 0.5, timestamp: Date.now(), step: 1 },
    });
    expect(ownRun.status).toBe(200);
    const newRun = await createRun(fixture, basic(jobToken));
    expect(newRun.status).toBe(403);
    expect(await mlflowErrorCode(newRun)).toBe('PERMISSION_DENIED');
  });

  it('native APIではBasic認証を401で拒否する', async () => {
    const fixture = await projectFixture(harness);
    const { token } = await personalToken(fixture, ['read']);
    const response = await request(harness.app, `${fixture.basePath}/experiments`, {
      headers: basic(token),
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('basic_auth_unsupported');
    expect((await request(harness.app, `${fixture.basePath}/experiments`, { token })).status).toBe(
      200,
    );
  });
});
