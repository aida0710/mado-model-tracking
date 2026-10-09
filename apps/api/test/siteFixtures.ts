import type { ComputeTarget, Job, Run, SiteSubmission } from '@mmt/contracts';
import { containerFixture } from './containerFixtures.js';
import { entity, request, type Harness } from './harness.js';

/** A site as tracking stores it: no connection settings, containers only. */
export function siteTargetInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test site',
    executor: 'site',
    host: '',
    port: 22,
    username: '',
    sshKeyPath: '',
    knownHostsPath: '',
    workDirectory: '',
    pythonExecutable: '',
    runtimeKinds: ['apptainer'],
    gpuIds: [],
    maxConcurrentJobs: 4,
    enabled: true,
    ...overrides,
  };
}

export async function siteFixture(harness: Harness, overrides: Record<string, unknown> = {}) {
  const fixture = await containerFixture(harness);
  const site = await entity<ComputeTarget>(
    await request(harness.app, '/api/targets', {
      method: 'POST',
      cookie: fixture.administrator.cookie,
      body: siteTargetInput(overrides),
    }),
  );
  // The requester's own token, as `mado-tracking submit` uses it.
  const personal = await entity<{ token: string }>(
    await request(harness.app, '/api/tokens', {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { name: 'Submit', kind: 'personal', projectId: fixture.project.id, scopes: ['read', 'jobs:write'] },
    }),
  );
  async function newContainerRun(name = 'Site inference'): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name,
          kind: 'inference',
          modelVersionId: fixture.modelVersion.id,
          codeVersionId: fixture.containerCodeVersion.id,
        },
      }),
    );
  }
  async function newSiteJob(body: Record<string, unknown> = {}): Promise<Job> {
    const run = await newContainerRun();
    return entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: site.id, gpuCount: 1, ...body },
      }),
    );
  }
  async function claim(launcherId = 'launcher-1'): Promise<SiteSubmission[]> {
    const claimed = await entity<{ items: SiteSubmission[] }>(
      await request(harness.app, '/api/worker/site-submissions/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { launcherId },
      }),
      200,
    );
    return claimed.items;
  }
  async function report(
    jobIds: string[],
    result: { outcome: 'submitted' | 'failed'; schedulerJobId?: string; error?: string },
    launcherId = 'launcher-1',
  ): Promise<Response> {
    return request(harness.app, '/api/worker/site-submissions/report', {
      method: 'POST',
      token: fixture.workerToken,
      body: { launcherId, results: [{ jobIds, ...result }] },
    });
  }
  return {
    ...fixture,
    site,
    personalToken: personal.token,
    newContainerRun,
    newSiteJob,
    claim,
    report,
  };
}

export type SiteFixture = Awaited<ReturnType<typeof siteFixture>>;

/** Calls a runner endpoint of the Job with its Job token. */
export function runnerRequest(
  harness: Harness,
  fixture: SiteFixture,
  call: { jobId: string; token: string; report: string; body: unknown },
): Promise<Response> {
  return request(harness.app, `${fixture.basePath}/jobs/${call.jobId}/runner/${call.report}`, {
    method: 'POST',
    token: call.token,
    body: call.body,
  });
}
