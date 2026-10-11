import { generateKeyPairSync } from 'node:crypto';
import type {
  ComputeTargetDetails,
  Job,
  LauncherConfiguration,
  LauncherCreated,
  Run,
  SiteKey,
  SiteSubmission,
} from '@mmt/contracts';
import { containerFixture } from './containerFixtures.js';
import { entity, request, type Harness } from './harness.js';

/** An OpenSSH ed25519 public key line, as `ssh-keygen` writes it into <key>.pub. */
export function sshPublicKeyLine(comment = 'mmt-launcher:test'): string {
  const raw = Buffer.from(
    generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!,
    'base64url',
  );
  const field = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  const blob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

/** The global settings of an automatic site with a shared account, submitted by `launcherId`. */
export function automaticSiteSettings(launcherId: string, overrides: Record<string, unknown> = {}) {
  return {
    launcherId,
    connection: {
      host: 'login.example.org',
      knownHosts: 'login.example.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKey',
    },
    accountMode: 'shared',
    sharedAccount: 'mmt',
    workDirectory: '/work/mmt',
    cancelCommand: 'qdel "$MMT_SCHEDULER_JOB_ID"',
    ...overrides,
  };
}

export const TEST_JOB_SHELL = '#!/bin/sh\nset -eu\nqsub -- "$MMT_RUNNER" "$MMT_SPEC_DIR"\n';

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
  async function newLauncher(name: string): Promise<LauncherCreated> {
    return entity<LauncherCreated>(
      await request(harness.app, '/api/launchers', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name },
      }),
    );
  }
  const launcher = await newLauncher('launcher-1');
  const manual = overrides.submissionMode === 'manual';
  const site = await entity<ComputeTargetDetails>(
    await request(harness.app, '/api/targets', {
      method: 'POST',
      cookie: fixture.administrator.cookie,
      body: {
        ...siteTargetInput(overrides),
        // A global administrator's site that the Project's members run their Jobs on.
        visibility: 'public',
        site: manual
          ? { accountMode: 'personal', workDirectory: '/work/mmt' }
          : automaticSiteSettings(launcher.launcher.id),
        jobShell: TEST_JOB_SHELL,
      },
    }),
  );
  async function launcherConfig(token = launcher.token): Promise<LauncherConfiguration> {
    return entity<LauncherConfiguration>(
      await request(harness.app, '/api/launcher/config', { token }),
      200,
    );
  }
  // The launcher makes the requested keys and sends their public halves.
  async function publishKeys(token = launcher.token): Promise<SiteKey[]> {
    const published: SiteKey[] = [];
    for (const key of (await launcherConfig(token)).keys.filter((item) => item.status === 'requested'))
      published.push(
        await entity<SiteKey>(
          await request(harness.app, `/api/launcher/keys/${key.id}`, {
            method: 'PUT',
            token,
            body: { publicKey: sshPublicKeyLine() },
          }),
          200,
        ),
      );
    return published;
  }
  await publishKeys();
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
  async function claim(token = launcher.token): Promise<SiteSubmission[]> {
    const claimed = await entity<{ items: SiteSubmission[] }>(
      await request(harness.app, '/api/launcher/site-submissions/claim', {
        method: 'POST',
        token,
        body: {},
      }),
      200,
    );
    return claimed.items;
  }
  async function report(
    jobIds: string[],
    result: { outcome: 'submitted' | 'failed'; schedulerJobId?: string; error?: string },
    token = launcher.token,
  ): Promise<Response> {
    return request(harness.app, '/api/launcher/site-submissions/report', {
      method: 'POST',
      token,
      body: { results: [{ jobIds, ...result }] },
    });
  }
  return {
    ...fixture,
    site,
    launcher: launcher.launcher,
    launcherToken: launcher.token,
    personalToken: personal.token,
    newLauncher,
    launcherConfig,
    publishKeys,
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
