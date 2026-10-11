import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ComputeTargetDetails,
  Job,
  LauncherCreated,
  ManualSiteConfiguration,
  ManualSubmissionWaiting,
  SiteConnectionCheck,
  SiteJobShell,
  SiteJobShellSummary,
  SiteKey,
  SitePersonalSettings,
  SiteSubmission,
} from '@mmt/contracts';
import { containerFixture, type ContainerFixture } from './containerFixtures.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { automaticSiteSettings, siteTargetInput, sshPublicKeyLine, TEST_JOB_SHELL } from './siteFixtures.js';

describe.skipIf(!testDatabaseUrl)('Webで足すコンピュータ（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: ContainerFixture;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await containerFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  function createTarget(cookie: string, body: Record<string, unknown>) {
    return request(harness.app, '/api/targets', { method: 'POST', cookie, body });
  }

  // A manual site the editor adds as their own computer (a PC that waits with submit --watch).
  async function ownComputer(overrides: Record<string, unknown> = {}): Promise<ComputeTargetDetails> {
    return entity<ComputeTargetDetails>(
      await createTarget(fixture.editor.cookie, {
        ...siteTargetInput({ name: 'Editor PC', submissionMode: 'manual', runtimeKinds: ['docker'] }),
        site: { workDirectory: '/home/editor/mmt', gpuAssignment: 'lease' },
        jobShell: TEST_JOB_SHELL,
        ...overrides,
      }),
    );
  }

  async function newLauncher(name = 'launcher-1'): Promise<LauncherCreated> {
    return entity<LauncherCreated>(
      await request(harness.app, '/api/launchers', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name },
      }),
    );
  }

  async function listTargets(cookie: string, projectId?: string): Promise<ComputeTargetDetails[]> {
    const query = projectId ? `?projectId=${projectId}` : '';
    return (
      await entity<{ items: ComputeTargetDetails[] }>(
        await request(harness.app, `/api/targets${query}`, { cookie }),
        200,
      )
    ).items;
  }

  async function containerRun(cookie: string, projectBase = fixture.basePath) {
    return entity<{ id: string }>(
      await request(harness.app, `${projectBase}/runs`, {
        method: 'POST',
        cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Site run',
          kind: 'inference',
          modelVersionId: fixture.modelVersion.id,
          codeVersionId: fixture.containerCodeVersion.id,
        },
      }),
    );
  }

  async function createJob(cookie: string, targetId: string): Promise<Response> {
    const run = await containerRun(cookie);
    return request(harness.app, `${fixture.basePath}/jobs`, {
      method: 'POST',
      cookie,
      body: { runId: run.id, targetId, gpuCount: 1 },
    });
  }

  async function memberEditor(email: string) {
    const person = await login(harness, email);
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${person.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'editor' },
      }),
      200,
    );
    return person;
  }

  async function personalToken(cookie: string): Promise<string> {
    return (
      await entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie,
          body: {
            name: 'Submit',
            kind: 'personal',
            projectId: fixture.project.id,
            scopes: ['read', 'jobs:write'],
          },
        }),
      )
    ).token;
  }

  it('研究者が足せるのは自分のsiteだけで、既定はPrivate、設定は所有者と全体管理者にだけ見える', async () => {
    const own = await ownComputer();
    expect(own).toMatchObject({
      ownerUserId: fixture.editor.userId,
      visibility: 'private',
      site: { workDirectory: '/home/editor/mmt', accountMode: 'personal', jobShell: { version: 1 } },
    });
    const local = await createTarget(fixture.editor.cookie, {
      ...siteTargetInput({ name: 'Local', executor: 'local', host: '127.0.0.1', username: 'me' }),
    });
    expect(local.status).toBe(403);
    expect(await local.json()).toMatchObject({ code: 'target_admin_required' });

    // Private: someone else does not get it among the computers they may use.
    expect((await listTargets(fixture.viewer.cookie)).map((target) => target.id)).not.toContain(own.id);
    const asAdministrator = (await listTargets(fixture.administrator.cookie)).find(
      (target) => target.id === own.id,
    );
    expect(asAdministrator).toMatchObject({ ownerName: expect.any(String), site: { workDirectory: '/home/editor/mmt' } });
    const hidden = await request(harness.app, `/api/targets/${own.id}/job-shells`, {
      cookie: fixture.outsider.cookie,
    });
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toMatchObject({ code: 'target_not_available' });

    // Public: its users see what the computer is, not its settings, and may not change it.
    await entity(
      await request(harness.app, `/api/targets/${own.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { visibility: 'public' },
      }),
      200,
    );
    const asViewer = (await listTargets(fixture.viewer.cookie, fixture.project.id)).find(
      (target) => target.id === own.id,
    );
    expect(asViewer).toMatchObject({
      site: null,
      siteAccountMode: 'personal',
      ownerUserId: fixture.editor.userId,
      visibility: 'public',
    });
    const patch = await request(harness.app, `/api/targets/${own.id}`, {
      method: 'PATCH',
      cookie: fixture.viewer.cookie,
      body: { name: 'Renamed' },
    });
    expect(patch.status).toBe(403);
    expect(await patch.json()).toMatchObject({ code: 'target_owner_required' });
    const audits = await harness.database.query<{ action: string; outcome: string }>(
      'SELECT action,outcome FROM audit_events WHERE resource_id=$1 ORDER BY occurred_at,id',
      [own.id],
    );
    expect(audits.rows).toEqual([
      { action: 'compute_target.create', outcome: 'success' },
      { action: 'compute_target.update', outcome: 'success' },
      { action: 'compute_target.update', outcome: 'denied' },
    ]);
  });

  it('job shellの無いコンピュータにはJobを作れない', async () => {
    const mine = await entity<Job>(await createJob(fixture.editor.cookie, (await ownComputer()).id));
    expect(mine.phase).toBe('waiting_manual');
    const withoutShell = await ownComputer({ name: 'No shell', jobShell: undefined });
    const missing = await createJob(fixture.editor.cookie, withoutShell.id);
    expect(await missing.json()).toMatchObject({ code: 'site_job_shell_missing' });
  });

  it('job shellは保存のたびに次のバージョンになり、同じ内容ならバージョンを増やさず、バージョンは変えられない', async () => {
    const own = await ownComputer();
    const save = (content: string, cookie = fixture.editor.cookie) =>
      request(harness.app, `/api/targets/${own.id}/job-shells`, { method: 'POST', cookie, body: { content } });
    const second = await entity<SiteJobShell>(await save('#!/bin/sh\necho v2\n'));
    expect(second).toMatchObject({ version: 2, content: '#!/bin/sh\necho v2\n', sizeBytes: 18 });
    const same = await entity<SiteJobShell>(await save('#!/bin/sh\necho v2\n'), 200);
    expect(same.id).toBe(second.id);
    expect((await save('#!/bin/sh\necho v3\n', fixture.viewer.cookie)).status).toBe(403);
    const history = await entity<{ items: SiteJobShellSummary[] }>(
      await request(harness.app, `/api/targets/${own.id}/job-shells`, { cookie: fixture.editor.cookie }),
      200,
    );
    expect(history.items.map((shell) => shell.version)).toEqual([2, 1]);
    const first = await entity<SiteJobShell>(
      await request(harness.app, `/api/targets/${own.id}/job-shells/${history.items[1]!.id}`, {
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(first.content).toBe(TEST_JOB_SHELL);
    expect((await listTargets(fixture.editor.cookie)).find((target) => target.id === own.id)?.site?.jobShell).toMatchObject({
      version: 2,
    });
    await expect(
      harness.database.query("UPDATE site_job_shells SET content='x' WHERE id=$1", [second.id]),
    ).rejects.toThrow('immutable');
  });

  it('本人アカウントのsiteは個人設定のある人だけが使え、launcherが作った鍵でログインする', async () => {
    const launcher = await newLauncher();
    const site = await entity<ComputeTargetDetails>(
      await createTarget(fixture.administrator.cookie, {
        ...siteTargetInput({ name: 'ABCI', visibility: 'public' }),
        site: automaticSiteSettings(launcher.launcher.id, { accountMode: 'personal', sharedAccount: '', workDirectory: '' }),
        jobShell: TEST_JOB_SHELL,
      }),
    );
    const withoutAccount = await createJob(fixture.editor.cookie, site.id);
    expect(await withoutAccount.json()).toMatchObject({ code: 'site_account_required' });
    const saved = await entity<SitePersonalSettings>(
      await request(harness.app, `/api/targets/${site.id}/personal-settings/me`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        body: { accountName: 'acb12345', workDirectory: '/groups/gxx/acb12345/mmt', variables: { GROUP: 'gxx' } },
      }),
      200,
    );
    expect(saved).toMatchObject({ accountName: 'acb12345', key: { status: 'requested', userId: fixture.editor.userId } });

    // The launcher makes the key and sends its public half; another launcher cannot.
    const config = await entity<{ keys: { id: string; status: string }[] }>(
      await request(harness.app, '/api/launcher/config', { token: launcher.token }),
      200,
    );
    expect(config.keys).toEqual([expect.objectContaining({ id: saved.key!.id, status: 'requested' })]);
    const publish = (keyId: string, publicKey: string, token = launcher.token) =>
      request(harness.app, `/api/launcher/keys/${keyId}`, { method: 'PUT', token, body: { publicKey } });
    const invalid = await publish(saved.key!.id, 'ssh-rsa AAAA not-ed25519');
    expect(await invalid.json()).toMatchObject({ code: 'invalid_public_key' });
    const other = await newLauncher('launcher-2');
    expect((await publish(saved.key!.id, sshPublicKeyLine(), other.token)).status).toBe(409);
    const publicKey = sshPublicKeyLine('mmt-launcher:launcher-1');
    const ready = await entity<SiteKey>(await publish(saved.key!.id, publicKey), 200);
    expect(ready).toMatchObject({ status: 'ready', publicKey, fingerprint: expect.stringMatching(/^SHA256:/) });

    const job = await entity<Job>(await createJob(fixture.editor.cookie, site.id));
    const claimed = await entity<{ items: SiteSubmission[] }>(
      await request(harness.app, '/api/launcher/site-submissions/claim', {
        method: 'POST',
        token: launcher.token,
        body: {},
      }),
      200,
    );
    expect(claimed.items).toHaveLength(1);
    expect(claimed.items[0]).toMatchObject({
      settings: { connection: { host: 'login.example.org' } },
      jobShell: { content: TEST_JOB_SHELL },
      account: {
        mode: 'personal',
        accountName: 'acb12345',
        workDirectory: '/groups/gxx/acb12345/mmt',
        variables: { GROUP: 'gxx' },
        keyId: ready.id,
      },
    });
    expect(claimed.items[0]!.jobs[0]!.job).toMatchObject({ id: job.id, siteJobShellId: claimed.items[0]!.jobShell.id });

    // A new key must be authorized again; until the launcher makes it, submissions fail.
    const rotated = await entity<SiteKey>(
      await request(harness.app, `/api/targets/${site.id}/keys/rotate`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { personal: true },
      }),
      200,
    );
    expect(rotated).toMatchObject({ status: 'requested' });
    expect(rotated.id).not.toBe(ready.id);
    const waiting = await entity<Job>(await createJob(fixture.editor.cookie, site.id));
    expect(
      (
        await entity<{ items: SiteSubmission[] }>(
          await request(harness.app, '/api/launcher/site-submissions/claim', {
            method: 'POST',
            token: launcher.token,
            body: {},
          }),
          200,
        )
      ).items,
    ).toEqual([]);
    const failed = await harness.database.query<{ status: string; error: string; end_reason: string }>(
      'SELECT status,error,end_reason FROM jobs WHERE id=$1',
      [waiting.id],
    );
    expect(failed.rows[0]).toMatchObject({ status: 'failed', end_reason: 'submit_failed' });
    expect(failed.rows[0]!.error).toContain('鍵をまだ作っていません');

    const everyone = await entity<{ items: SitePersonalSettings[] }>(
      await request(harness.app, `/api/targets/${site.id}/personal-settings`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(everyone.items).toEqual([expect.objectContaining({ accountName: 'acb12345', key: expect.objectContaining({ id: rotated.id }) })]);
    expect(
      (await request(harness.app, `/api/targets/${site.id}/personal-settings`, { cookie: fixture.editor.cookie }))
        .status,
    ).toBe(403);
  });

  it('接続確認はlauncherがその鍵でログインした結果を残し、答えのない確認は5分で失敗になる', async () => {
    const launcher = await newLauncher();
    const site = await entity<ComputeTargetDetails>(
      await createTarget(fixture.administrator.cookie, {
        ...siteTargetInput({ name: 'GPU host', visibility: 'public' }),
        site: automaticSiteSettings(launcher.launcher.id),
        jobShell: TEST_JOB_SHELL,
      }),
    );
    // Its users see that it runs as one shared account, which takes no settings of theirs.
    expect((await listTargets(fixture.editor.cookie)).find((target) => target.id === site.id)).toMatchObject({
      site: null,
      siteAccountMode: 'shared',
    });
    const personal = await request(harness.app, `/api/targets/${site.id}/personal-settings/me`, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      body: { variables: { GROUP: 'other' } },
    });
    expect(personal.status).toBe(422);
    expect(await personal.json()).toMatchObject({ code: 'site_settings_invalid' });
    const ask = () =>
      request(harness.app, `/api/targets/${site.id}/connection-checks`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { personal: false },
      });
    const beforeKey = await ask();
    expect(await beforeKey.json()).toMatchObject({ code: 'site_check_unavailable' });
    const [key] = (
      await entity<{ keys: { id: string }[] }>(
        await request(harness.app, '/api/launcher/config', { token: launcher.token }),
        200,
      )
    ).keys;
    await entity(
      await request(harness.app, `/api/launcher/keys/${key!.id}`, {
        method: 'PUT',
        token: launcher.token,
        body: { publicKey: sshPublicKeyLine() },
      }),
      200,
    );
    const check = await entity<SiteConnectionCheck>(await ask());
    expect(check).toMatchObject({ status: 'queued', userId: null });
    expect((await ask()).status).toBe(409);
    const config = await entity<{ checks: { id: string; account: { accountName: string; keyId: string } }[] }>(
      await request(harness.app, '/api/launcher/config', { token: launcher.token }),
      200,
    );
    expect(config.checks).toEqual([
      { id: check.id, targetId: site.id, account: expect.objectContaining({ accountName: 'mmt', keyId: key!.id }) },
    ]);
    expect(
      (
        await request(harness.app, `/api/launcher/connection-checks/${check.id}`, {
          method: 'POST',
          token: launcher.token,
          body: { outcome: 'failed', message: 'Permission denied (publickey).' },
        })
      ).status,
    ).toBe(204);
    const listed = await entity<{ items: SiteConnectionCheck[] }>(
      await request(harness.app, `/api/targets/${site.id}/connection-checks?personal=false`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(listed.items[0]).toMatchObject({ status: 'failed', message: 'Permission denied (publickey).' });
    const stale = await entity<SiteConnectionCheck>(await ask());
    await harness.database.query(
      "UPDATE site_connection_checks SET created_at=now()-interval '10 minutes' WHERE id=$1",
      [stale.id],
    );
    const expired = await entity<{ items: SiteConnectionCheck[] }>(
      await request(harness.app, `/api/targets/${site.id}/connection-checks?personal=false`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(expired.items.find((item) => item.id === stale.id)).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('launcher'),
    });
  });

  it('launcherのtokenはlauncherのAPIにだけ届き、作り直すと古いtokenは止まる', async () => {
    const launcher = await newLauncher();
    expect((await request(harness.app, '/api/targets', { token: launcher.token })).status).toBe(403);
    const token = await personalToken(fixture.editor.cookie);
    const notLauncher = await request(harness.app, '/api/launcher/config', { token });
    expect(notLauncher.status).toBe(403);
    expect(await notLauncher.json()).toMatchObject({ code: 'launcher_token_required' });
    const duplicate = await request(harness.app, '/api/launchers', {
      method: 'POST',
      cookie: fixture.administrator.cookie,
      body: { name: 'LAUNCHER-1' },
    });
    expect(duplicate.status).toBe(409);
    expect(
      (await request(harness.app, '/api/launchers', { method: 'POST', cookie: fixture.editor.cookie, body: { name: 'x' } }))
        .status,
    ).toBe(403);
    const seen = await entity<{ items: { tokenPrefix: string | null }[] }>(
      await request(harness.app, '/api/launchers', { cookie: fixture.editor.cookie }),
      200,
    );
    expect(seen.items).toEqual([expect.objectContaining({ tokenPrefix: null })]);

    const site = await entity<ComputeTargetDetails>(
      await createTarget(fixture.administrator.cookie, {
        ...siteTargetInput({ name: 'Shared host', visibility: 'public' }),
        site: automaticSiteSettings(launcher.launcher.id),
        jobShell: TEST_JOB_SHELL,
      }),
    );
    const [key] = (
      await entity<{ keys: { id: string }[] }>(
        await request(harness.app, '/api/launcher/config', { token: launcher.token }),
        200,
      )
    ).keys;
    await entity(
      await request(harness.app, `/api/launcher/keys/${key!.id}`, {
        method: 'PUT',
        token: launcher.token,
        body: { publicKey: sshPublicKeyLine() },
      }),
      200,
    );
    const job = await entity<Job>(await createJob(fixture.editor.cookie, site.id));
    await entity(
      await request(harness.app, '/api/launcher/site-submissions/claim', {
        method: 'POST',
        token: launcher.token,
        body: {},
      }),
      200,
    );
    const replaced = await entity<LauncherCreated>(
      await request(harness.app, `/api/launchers/${launcher.launcher.id}/token`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
      }),
    );
    expect((await request(harness.app, '/api/launcher/config', { token: launcher.token })).status).toBe(401);
    // What the launcher submitted with its old token it reports with the new one.
    const reported = await entity<{ items: Job[] }>(
      await request(harness.app, '/api/launcher/site-submissions/report', {
        method: 'POST',
        token: replaced.token,
        body: { results: [{ jobIds: [job.id], outcome: 'submitted', schedulerJobId: '1.pbs' }] },
      }),
      200,
    );
    expect(reported.items[0]).toMatchObject({ phase: 'submitted' });
    expect(
      (
        await request(harness.app, `/api/launchers/${launcher.launcher.id}`, {
          method: 'DELETE',
          cookie: fixture.administrator.cookie,
        })
      ).status,
    ).toBe(204);
    expect((await request(harness.app, '/api/launcher/config', { token: replaced.token })).status).toBe(401);
    const revokedSiteJob = await createJob(fixture.editor.cookie, site.id);
    expect(await revokedSiteJob.json()).toMatchObject({ code: 'site_launcher_missing' });
    const audits = await harness.database.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE resource_id=$1 ORDER BY occurred_at,id",
      [launcher.launcher.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      'launcher.create',
      'launcher.token.replace',
      'launcher.revoke',
    ]);
  });

  it('所有者は公開した自分のコンピュータの全員のJobを投入でき、他の人は自分のJobだけ', async () => {
    const own = await ownComputer({ visibility: 'public' });
    const colleague = await memberEditor('colleague@localhost');
    const colleagueJob = await entity<Job>(await createJob(colleague.cookie, own.id));
    const colleagueToken = await personalToken(colleague.cookie);
    const ownerToken = await personalToken(fixture.editor.cookie);
    const configuration = await entity<ManualSiteConfiguration>(
      await request(harness.app, `/api/manual-submissions/sites/${own.id}`, { token: colleagueToken }),
      200,
    );
    expect(configuration).toMatchObject({
      jobShell: { version: 1 },
      account: { mode: 'personal', workDirectory: '/home/editor/mmt', keyId: null },
    });
    const takeAll = (token: string) =>
      request(harness.app, '/api/manual-submissions/claim', {
        method: 'POST',
        token,
        body: { targetId: own.id, submitterId: 'pc', all: true },
      });
    const refused = await takeAll(colleagueToken);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'site_owner_required' });
    const waiting = await entity<{ items: ManualSubmissionWaiting[] }>(
      await request(harness.app, '/api/manual-submissions', { token: ownerToken }),
      200,
    );
    expect(waiting.items).toEqual([
      { targetId: own.id, targetName: own.name, waitingJobs: 0, allWaitingJobs: 1 },
    ]);
    const claimed = await entity<{ items: SiteSubmission[] }>(await takeAll(ownerToken), 200);
    expect(claimed.items.map((submission) => submission.jobs[0]!.job.id)).toEqual([colleagueJob.id]);
    expect(claimed.items[0]).toMatchObject({
      requester: { id: colleague.userId },
      account: { workDirectory: '/home/editor/mmt' },
    });
  });
});
