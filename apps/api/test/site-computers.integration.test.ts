import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ComputeTargetDetails,
  Job,
  LauncherCreated,
  ManualSiteConfiguration,
  ManualSubmissionWaiting,
  Project,
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

describe.skipIf(!testDatabaseUrl)('Webで足す計算機（独立PostgreSQL）', () => {
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

  it('研究者は自分の計算機（site）だけを足せ、設定は所有者と全体管理者にだけ見える', async () => {
    const own = await ownComputer();
    expect(own).toMatchObject({
      ownerUserId: fixture.editor.userId,
      projectIds: [],
      site: { workDirectory: '/home/editor/mmt', accountMode: 'personal', jobShell: { version: 1 } },
    });
    const global = await createTarget(fixture.editor.cookie, {
      ...siteTargetInput({ name: 'Not mine', submissionMode: 'manual' }),
      personal: false,
    });
    expect(global.status).toBe(403);
    expect(await global.json()).toMatchObject({ code: 'target_admin_required' });
    const local = await createTarget(fixture.editor.cookie, {
      ...siteTargetInput({ name: 'Local', executor: 'local', host: '127.0.0.1', username: 'me' }),
    });
    expect(await local.json()).toMatchObject({ code: 'target_admin_required' });

    // Not shared: only its owner and global administrators see it.
    expect((await listTargets(fixture.viewer.cookie)).map((target) => target.id)).not.toContain(own.id);
    const asAdministrator = (await listTargets(fixture.administrator.cookie)).find(
      (target) => target.id === own.id,
    );
    expect(asAdministrator).toMatchObject({ ownerName: expect.any(String), site: { workDirectory: '/home/editor/mmt' } });
    const hidden = await request(harness.app, `/api/targets/${own.id}/job-shells`, {
      cookie: fixture.outsider.cookie,
    });
    expect(hidden.status).toBe(404);

    // Shared with the Project: its members see what the computer is, not its settings.
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const share = (projectIds: string[], cookie = fixture.editor.cookie) =>
      request(harness.app, `/api/targets/${own.id}/projects`, {
        method: 'PUT',
        cookie,
        body: { projectIds },
      });
    const foreign = await share([other.id]);
    expect(foreign.status).toBe(422);
    expect(await foreign.json()).toMatchObject({ code: 'target_project_forbidden' });
    expect((await share([fixture.project.id], fixture.viewer.cookie)).status).toBe(404);
    expect(await entity<ComputeTargetDetails>(await share([fixture.project.id]), 200)).toMatchObject({
      projectIds: [fixture.project.id],
    });
    const asViewer = (await listTargets(fixture.viewer.cookie, fixture.project.id)).find(
      (target) => target.id === own.id,
    );
    expect(asViewer).toMatchObject({
      site: null,
      siteAccountMode: 'personal',
      projectIds: [],
      ownerUserId: fixture.editor.userId,
    });
    expect((await listTargets(fixture.viewer.cookie, other.id).catch(() => [])).length).toBe(0);
    const patch = await request(harness.app, `/api/targets/${own.id}`, {
      method: 'PATCH',
      cookie: fixture.viewer.cookie,
      body: { name: 'Renamed' },
    });
    expect(patch.status).toBe(403);
    expect(await patch.json()).toMatchObject({ code: 'target_owner_required' });
    const audits = await harness.database.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE resource_id=$1 AND outcome='success' ORDER BY occurred_at,id",
      [own.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual(['compute_target.create', 'compute_target.share']);
  });

  it('共有先の候補は所有者がeditor以上（実効role）のProjectで、全体管理者にも所有者の候補を返す', async () => {
    const own = await ownComputer();
    const candidates = (cookie: string, targetId = own.id) =>
      request(harness.app, `/api/targets/${targetId}/shareable-projects`, { cookie });
    const newProject = async (name: string, cookie = fixture.administrator.cookie) =>
      entity<Project>(await request(harness.app, '/api/projects', { method: 'POST', cookie, body: { name } }));
    const makeOwnerViewer = async (project: Project) =>
      entity(
        await request(harness.app, `/api/projects/${project.id}/members/${fixture.editor.userId}`, {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { role: 'viewer' },
        }),
        200,
      );
    // The owner only views one Project, is an editor of another through an SSO group (on top of
    // a direct viewer grant), created a third (admin), and is not in the administrator's fourth.
    const viewed = await newProject('Viewed Project');
    await makeOwnerViewer(viewed);
    const grouped = await newProject('Grouped Project');
    await makeOwnerViewer(grouped);
    await harness.database.query("INSERT INTO user_groups(user_id,group_name) VALUES($1,'ml-team')", [
      fixture.editor.userId,
    ]);
    await entity(
      await request(harness.app, `/api/projects/${grouped.id}/group-bindings/ml-team`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'editor' },
      }),
      200,
    );
    const created = await newProject('Own Project', fixture.editor.cookie);
    await newProject('Administrator Project');
    const shareable = {
      items: [
        { id: grouped.id, name: 'Grouped Project' },
        { id: created.id, name: 'Own Project' },
        { id: fixture.project.id, name: 'Test Project' },
      ],
    };
    expect(await entity(await candidates(fixture.editor.cookie), 200)).toEqual(shareable);
    // A global administrator editing the researcher's computer gets the owner's Projects, not theirs.
    expect(await entity(await candidates(fixture.administrator.cookie), 200)).toEqual(shareable);

    // Someone who may not use the computer does not see it; a user of it may not manage it.
    expect((await candidates(fixture.viewer.cookie)).status).toBe(404);
    const share = (projectIds: string[]) =>
      request(harness.app, `/api/targets/${own.id}/projects`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { projectIds },
      });
    const shared = await entity<ComputeTargetDetails>(
      await share(shareable.items.map((project) => project.id)),
      200,
    );
    expect([...shared.projectIds].sort()).toEqual(shareable.items.map((project) => project.id).sort());
    expect(await (await share([viewed.id])).json()).toMatchObject({ code: 'target_project_forbidden' });
    const member = await candidates(fixture.viewer.cookie);
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ code: 'target_owner_required' });
    const outsider = await candidates(fixture.outsider.cookie);
    expect(outsider.status).toBe(404);
    expect(await outsider.json()).toMatchObject({ code: 'not_found' });

    // A global computer serves every Project, so it has nothing to share.
    const global = await candidates(fixture.administrator.cookie, fixture.target.id);
    expect(global.status).toBe(422);
    expect(await global.json()).toMatchObject({ code: 'target_not_owned' });
    expect((await candidates(fixture.editor.cookie, fixture.target.id)).status).toBe(403);
  });

  it('自分の計算機を足すときの候補は本人がeditor以上のProjectで、全体管理者もメンバーでないProjectは出ない', async () => {
    const newProject = async (name: string, cookie: string) =>
      entity<Project>(await request(harness.app, '/api/projects', { method: 'POST', cookie, body: { name } }));
    const researchers = await newProject('Own Project', fixture.editor.cookie);
    const administrators = await newProject('Administrator Project', fixture.administrator.cookie);
    const candidates = (options: { cookie?: string; token?: string }) =>
      request(harness.app, '/api/targets/shareable-projects', options);
    expect(await entity(await candidates({ cookie: fixture.editor.cookie }), 200)).toEqual({
      items: [
        { id: researchers.id, name: 'Own Project' },
        { id: fixture.project.id, name: 'Test Project' },
      ],
    });
    // A global administrator sees every Project, but shares only with those they are a member of.
    const forAdministrator = {
      items: [
        { id: administrators.id, name: 'Administrator Project' },
        { id: fixture.project.id, name: 'Test Project' },
      ],
    };
    expect(await entity(await candidates({ cookie: fixture.administrator.cookie }), 200)).toEqual(forAdministrator);
    const addOwn = (name: string, projectIds: string[]) =>
      createTarget(fixture.administrator.cookie, {
        ...siteTargetInput({ name, submissionMode: 'manual', runtimeKinds: ['docker'] }),
        site: { workDirectory: '/home/admin/mmt', gpuAssignment: 'lease' },
        personal: true,
        projectIds,
      });
    const refused = await addOwn('Not a member', [researchers.id]);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'target_project_forbidden' });
    const added = await entity<ComputeTargetDetails>(
      await addOwn('Administrator PC', forAdministrator.items.map((project) => project.id)),
    );
    expect([...added.projectIds].sort()).toEqual(forAdministrator.items.map((project) => project.id).sort());

    // Only those who may add a computer of their own: a browser session or a global administrator.
    const byToken = await candidates({ token: await personalToken(fixture.editor.cookie) });
    expect(byToken.status).toBe(403);
    expect(await byToken.json()).toMatchObject({ code: 'session_required' });
  });

  it('共有していない計算機にはJobを作れず、job shellの無い計算機にも作れない', async () => {
    const own = await ownComputer();
    const notShared = await createJob(fixture.administrator.cookie, own.id);
    expect(notShared.status).toBe(422);
    expect(await notShared.json()).toMatchObject({ code: 'target_not_available' });
    const mine = await entity<Job>(await createJob(fixture.editor.cookie, own.id));
    expect(mine.phase).toBe('waiting_manual');
    await entity(
      await request(harness.app, `/api/targets/${own.id}/projects`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        body: { projectIds: [fixture.project.id] },
      }),
      200,
    );
    await entity<Job>(await createJob(fixture.administrator.cookie, own.id));
    const withoutShell = await ownComputer({ name: 'No shell', jobShell: undefined });
    const missing = await createJob(fixture.editor.cookie, withoutShell.id);
    expect(await missing.json()).toMatchObject({ code: 'site_job_shell_missing' });
  });

  it('job shellは保存のたびに次の版になり、同じ内容なら版を増やさず、版は変えられない', async () => {
    const own = await ownComputer();
    const save = (content: string, cookie = fixture.editor.cookie) =>
      request(harness.app, `/api/targets/${own.id}/job-shells`, { method: 'POST', cookie, body: { content } });
    const second = await entity<SiteJobShell>(await save('#!/bin/sh\necho v2\n'));
    expect(second).toMatchObject({ version: 2, content: '#!/bin/sh\necho v2\n', sizeBytes: 18 });
    const same = await entity<SiteJobShell>(await save('#!/bin/sh\necho v2\n'), 200);
    expect(same.id).toBe(second.id);
    expect((await save('#!/bin/sh\necho v3\n', fixture.viewer.cookie)).status).toBe(404);
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
        ...siteTargetInput({ name: 'ABCI' }),
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
        ...siteTargetInput({ name: 'GPU host' }),
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
        ...siteTargetInput({ name: 'Shared host' }),
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

  it('所有者は共有した自分の計算機の全員のJobを投入でき、他の人は自分のJobだけ', async () => {
    const own = await ownComputer();
    await entity(
      await request(harness.app, `/api/targets/${own.id}/projects`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        body: { projectIds: [fixture.project.id] },
      }),
      200,
    );
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
