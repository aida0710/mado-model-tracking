import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ComputeTargetDetails,
  ComputeTargetOverview,
  Hook,
  HookCreated,
  HookExecution,
  Job,
  LauncherCreated,
  ServiceAccount,
  SiteSubmission,
  WorkerJob,
} from '@mmt/contracts';
import { migrate } from '../src/db/migrate.js';
import { automationRuleInput, containerFixture, type ContainerFixture } from './containerFixtures.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { applyMigrationsBefore } from './migrationFixtures.js';
import { automaticSiteSettings, siteTargetInput, TEST_JOB_SHELL } from './siteFixtures.js';

type Caller = { cookie?: string; token?: string };

describe.skipIf(!testDatabaseUrl)('コンピュータの公開範囲（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: ContainerFixture;
  // The researcher who adds the private computer; a Project admin, so they create Service
  // Accounts, rules and hook owners of their own.
  let owner: { cookie: string; userId: string };
  let colleague: { cookie: string; userId: string };
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await containerFixture(harness);
    owner = fixture.editor;
    await setRole(owner.userId, 'admin');
    colleague = await login(harness, 'colleague@localhost');
    await setRole(colleague.userId, 'editor');
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function setRole(userId: string, role: 'editor' | 'admin') {
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role },
      }),
      200,
    );
  }

  // The owner's PC: a manual site that runs containers.
  async function ownerComputer(overrides: Record<string, unknown> = {}): Promise<ComputeTargetDetails> {
    return entity<ComputeTargetDetails>(
      await request(harness.app, '/api/targets', {
        method: 'POST',
        cookie: owner.cookie,
        body: {
          ...siteTargetInput({ name: 'Owner PC', submissionMode: 'manual', runtimeKinds: ['docker'] }),
          site: { workDirectory: '/home/owner/mmt', gpuAssignment: 'lease' },
          jobShell: TEST_JOB_SHELL,
          ...overrides,
        },
      }),
    );
  }

  function patchTarget(targetId: string, cookie: string, body: Record<string, unknown>) {
    return request(harness.app, `/api/targets/${targetId}`, { method: 'PATCH', cookie, body });
  }

  async function createJob(caller: Caller, targetId: string): Promise<Response> {
    const run = await entity<{ id: string }>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        ...caller,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Run on a computer',
          kind: 'inference',
          modelVersionId: fixture.modelVersion.id,
          codeVersionId: fixture.containerCodeVersion.id,
        },
      }),
    );
    return request(harness.app, `${fixture.basePath}/jobs`, {
      method: 'POST',
      ...caller,
      body: { runId: run.id, targetId },
    });
  }

  async function expectRefused(response: Response): Promise<void> {
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'target_not_available' });
  }

  async function serviceAccount(creatorCookie: string, name: string): Promise<ServiceAccount> {
    return entity<ServiceAccount>(
      await request(harness.app, `${fixture.basePath}/service-accounts`, {
        method: 'POST',
        cookie: creatorCookie,
        body: { name, role: 'editor', description: `${name} for tests` },
      }),
    );
  }

  async function serviceAccountToken(account: ServiceAccount, cookie: string): Promise<string> {
    return (
      await entity<{ token: string }>(
        await request(harness.app, `${fixture.basePath}/service-accounts/${account.id}/tokens`, {
          method: 'POST',
          cookie,
          body: { name: `${account.name} key`, scopes: ['read', 'runs:write', 'jobs:write'] },
        }),
      )
    ).token;
  }

  async function overview(cookie: string): Promise<ComputeTargetOverview[]> {
    return (
      await entity<{ items: ComputeTargetOverview[] }>(
        await request(harness.app, '/api/targets/overview', { cookie }),
        200,
      )
    ).items;
  }

  async function listTargets(cookie: string): Promise<ComputeTargetDetails[]> {
    return (
      await entity<{ items: ComputeTargetDetails[] }>(
        await request(harness.app, '/api/targets', { cookie }),
        200,
      )
    ).items;
  }

  async function visibilityAudits(targetId: string) {
    return (
      await harness.database.query<{ outcome: string; details: Record<string, unknown> }>(
        `SELECT outcome,details FROM audit_events WHERE resource_id=$1 AND action='compute_target.update'
        ORDER BY occurred_at,id`,
        [targetId],
      )
    ).rows;
  }

  async function jobRow(jobId: string) {
    return (
      await harness.database.query<{ status: string; end_reason: string | null; error: string | null }>(
        'SELECT status,end_reason,error FROM jobs WHERE id=$1',
        [jobId],
      )
    ).rows[0]!;
  }

  it('Privateのコンピュータで動かせるのは所有者と所有者が作ったService Accountだけで、全体管理者も所有者でなければ動かせない', async () => {
    const computer = await ownerComputer();
    expect(computer).toMatchObject({ ownerUserId: owner.userId, visibility: 'private' });
    await entity<Job>(await createJob({ cookie: owner.cookie }, computer.id));
    await expectRefused(await createJob({ cookie: fixture.administrator.cookie }, computer.id));
    await expectRefused(await createJob({ cookie: colleague.cookie }, computer.id));

    const ownersAccount = await serviceAccount(owner.cookie, 'Owner bot');
    await entity<Job>(
      await createJob({ token: await serviceAccountToken(ownersAccount, owner.cookie) }, computer.id),
    );
    const administratorsAccount = await serviceAccount(fixture.administrator.cookie, 'Admin bot');
    await expectRefused(
      await createJob(
        { token: await serviceAccountToken(administratorsAccount, fixture.administrator.cookie) },
        computer.id,
      ),
    );

    // A global administrator may open it to everyone without being able to use it before.
    await entity(await patchTarget(computer.id, fixture.administrator.cookie, { visibility: 'public' }), 200);
    await entity<Job>(await createJob({ cookie: colleague.cookie }, computer.id));
    await entity<Job>(await createJob({ cookie: fixture.administrator.cookie }, computer.id));
  });

  it('フックと自動実行はその所有者として確かめ、それがコンピュータの所有者でなければPrivateのコンピュータで動かない', async () => {
    const computer = await ownerComputer();
    const template = {
      experimentId: fixture.experiment.id,
      kind: 'inference',
      codeVersionId: fixture.containerCodeVersion.id,
      modelVersionId: fixture.modelVersion.id,
      targetId: computer.id,
    };
    const createHook = (cookie: string) =>
      request(harness.app, `${fixture.basePath}/hooks`, {
        method: 'POST',
        cookie,
        body: { name: 'Manual hook', trigger: 'manual', template },
      });
    await expectRefused(await createHook(colleague.cookie));
    const { hook } = await entity<HookCreated>(await createHook(owner.cookie));
    const trigger = async () =>
      entity<HookExecution>(
        await request(harness.app, `${fixture.basePath}/hooks/${hook.id}/trigger`, {
          method: 'POST',
          cookie: owner.cookie,
          body: {},
        }),
      );
    expect(await trigger()).toMatchObject({ status: 'queued' });

    // Moved to a Service Account someone else created, the hook runs as someone who may not use it.
    const transfer = async (account: ServiceAccount) =>
      entity<Hook>(
        await request(harness.app, `${fixture.basePath}/hooks/${hook.id}/owner`, {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { serviceAccountId: account.id },
        }),
        200,
      );
    await transfer(await serviceAccount(fixture.administrator.cookie, 'Admin hook bot'));
    const refused = await trigger();
    expect(refused).toMatchObject({ status: 'failed', jobId: null });
    expect(refused.error).toContain('Private');
    await transfer(await serviceAccount(owner.cookie, 'Owner hook bot'));
    expect(await trigger()).toMatchObject({ status: 'queued' });

    // A rule runs as whoever creates it.
    const createRule = (cookie: string) =>
      request(harness.app, `${fixture.basePath}/automation-rules`, {
        method: 'POST',
        cookie,
        body: automationRuleInput(fixture, { targetId: computer.id }),
      });
    await expectRefused(await createRule(fixture.administrator.cookie));
    expect((await createRule(owner.cookie)).status).toBe(201);
  });

  it('一覧には他人のPrivateのコンピュータも出るが、接続先や設定は出さない', async () => {
    const computer = await ownerComputer();
    const launcher = await entity<LauncherCreated>(
      await request(harness.app, '/api/launchers', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'launcher-1' },
      }),
    );
    const site = await entity<ComputeTargetDetails>(
      await request(harness.app, '/api/targets', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          ...siteTargetInput({ name: 'Supercomputer', visibility: 'public' }),
          site: automaticSiteSettings(launcher.launcher.id),
          jobShell: TEST_JOB_SHELL,
        },
      }),
    );
    const seenBy = async (cookie: string) =>
      Object.fromEntries((await overview(cookie)).map((row) => [row.id, row]));

    const asViewer = await seenBy(fixture.viewer.cookie);
    expect(asViewer[computer.id]).toEqual({
      id: computer.id,
      name: 'Owner PC',
      executor: 'site',
      submissionMode: 'manual',
      cpuArch: 'amd64',
      supportsArray: false,
      enabled: true,
      visibility: 'private',
      ownerUserId: owner.userId,
      ownerName: expect.any(String),
      usable: false,
      canManage: false,
      launcher: null,
    });
    expect(asViewer[site.id]).toMatchObject({
      usable: true,
      canManage: false,
      launcher: { name: 'launcher-1', lastSeenAt: null, revoked: false },
    });
    expect(asViewer[fixture.target.id]).toMatchObject({ executor: 'local', usable: true });
    const listed = JSON.stringify(await overview(fixture.viewer.cookie));
    for (const secret of ['/home/owner/mmt', 'login.example.org', '/tmp/mmt-test-worker', '127.0.0.1'])
      expect(listed).not.toContain(secret);
    expect((await listTargets(fixture.viewer.cookie)).map((target) => target.id)).not.toContain(
      computer.id,
    );

    expect((await seenBy(fixture.administrator.cookie))[computer.id]).toMatchObject({
      usable: false,
      canManage: true,
    });
    expect((await seenBy(owner.cookie))[computer.id]).toMatchObject({ usable: true, canManage: true });
    // The administrator manages it, so its details are theirs to see; its job shell too.
    expect((await listTargets(fixture.administrator.cookie)).find((target) => target.id === computer.id))
      .toMatchObject({ site: { workDirectory: '/home/owner/mmt' } });
  });

  it('公開範囲を変えられるのは所有者と全体管理者で、変更は監査に残り、所有者のいないコンピュータはPrivateにできない', async () => {
    const computer = await ownerComputer();
    const byColleague = await patchTarget(computer.id, colleague.cookie, { visibility: 'public' });
    expect(byColleague.status).toBe(403);
    expect(await byColleague.json()).toMatchObject({ code: 'target_owner_required' });
    expect(
      await entity<ComputeTargetDetails>(await patchTarget(computer.id, owner.cookie, { visibility: 'public' }), 200),
    ).toMatchObject({ visibility: 'public' });
    await entity(await patchTarget(computer.id, fixture.administrator.cookie, { visibility: 'private' }), 200);
    // Saving the same visibility is not a change.
    await entity(await patchTarget(computer.id, owner.cookie, { name: 'Owner PC 2', visibility: 'private' }), 200);
    expect(await visibilityAudits(computer.id)).toEqual([
      { outcome: 'denied', details: expect.objectContaining({ code: 'target_owner_required' }) },
      {
        outcome: 'success',
        details: expect.objectContaining({ visibility: { from: 'private', to: 'public' } }),
      },
      {
        outcome: 'success',
        details: expect.objectContaining({ visibility: { from: 'public', to: 'private' } }),
      },
      { outcome: 'success', details: { fields: ['name', 'visibility'], siteFields: [] } },
    ]);

    // A computer from before owners serves everyone and has no one to be private for.
    await harness.database.query('UPDATE compute_targets SET owner_user_id=NULL WHERE id=$1', [
      fixture.target.id,
    ]);
    const ownerless = await patchTarget(fixture.target.id, fixture.administrator.cookie, {
      visibility: 'private',
    });
    expect(ownerless.status).toBe(422);
    expect(await ownerless.json()).toMatchObject({ code: 'target_owner_missing' });
    await expect(
      harness.database.query("UPDATE compute_targets SET visibility='private' WHERE id=$1", [
        fixture.target.id,
      ]),
    ).rejects.toThrow('target_private_owner');
  });

  it('待機中のJobのコンピュータがあとでPrivateになると、Jobは投入のときに失敗する', async () => {
    // ssh/local: the worker's claim fails it instead of running it.
    const queued = await entity<Job>(await createJob({ cookie: colleague.cookie }, fixture.target.id));
    await entity(await patchTarget(fixture.target.id, fixture.administrator.cookie, { visibility: 'private' }), 200);
    const claimed = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'worker-1' },
      }),
      200,
    );
    expect(claimed.item).toBeNull();
    const failedLocal = await jobRow(queued.id);
    expect(failedLocal).toMatchObject({ status: 'failed', end_reason: 'submit_failed' });
    expect(failedLocal.error).toContain('Private');

    // A site: the submission fails it, as for a requester without an account there.
    const computer = await ownerComputer({ visibility: 'public' });
    const waiting = await entity<Job>(await createJob({ cookie: colleague.cookie }, computer.id));
    expect(waiting.phase).toBe('waiting_manual');
    await entity(await patchTarget(computer.id, owner.cookie, { visibility: 'private' }), 200);
    const ownerToken = (
      await entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: owner.cookie,
          body: {
            name: 'Submit',
            kind: 'personal',
            projectId: fixture.project.id,
            scopes: ['read', 'jobs:write'],
          },
        }),
      )
    ).token;
    const submitted = await entity<{ items: SiteSubmission[] }>(
      await request(harness.app, '/api/manual-submissions/claim', {
        method: 'POST',
        token: ownerToken,
        body: { targetId: computer.id, submitterId: 'pc', all: true },
      }),
      200,
    );
    expect(submitted.items).toEqual([]);
    const failedSite = await jobRow(waiting.id);
    expect(failedSite).toMatchObject({ status: 'failed', end_reason: 'submit_failed' });
    expect(failedSite.error).toContain('Private');
  });
});

describe.skipIf(!testDatabaseUrl)('コンピュータの公開範囲の移行（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({ applyMigrations: false });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('migration 057で所有者のいないコンピュータはpublic、所有者のいるものはprivateになり、Projectへの共有は消える', async () => {
    await applyMigrationsBefore(harness.database, '057_compute_target_visibility.sql');
    const legacy = await harness.database.query<{ owned_id: string; global_id: string; owner_id: string }>(`
      WITH owner AS (
        INSERT INTO users(issuer,subject,email,display_name) VALUES('fixture','owner','owner@localhost','Owner') RETURNING id
      ), project AS (INSERT INTO projects(name) VALUES('Shared with') RETURNING id),
      owned AS (
        INSERT INTO compute_targets(name,host,port,username,ssh_key_path,known_hosts_path,work_directory,python_executable,
          max_concurrent_jobs,executor,runtime_kinds,dataset_transfer,owner_user_id)
        SELECT 'Owner PC','',22,'','','','','',1,'site','{docker}','direct',owner.id FROM owner RETURNING id
      ), global AS (
        INSERT INTO compute_targets(name,host,port,username,ssh_key_path,known_hosts_path,work_directory,python_executable,
          max_concurrent_jobs,executor)
        VALUES('GPU host','gpu.internal',22,'mmt','/keys/id','/keys/known_hosts','/srv/mmt','python3',1,'ssh') RETURNING id
      ), shared AS (
        INSERT INTO compute_target_projects(target_id,project_id,created_by)
        SELECT owned.id,project.id,owner.id FROM owned,project,owner
      )
      SELECT owned.id AS owned_id,global.id AS global_id,owner.id AS owner_id FROM owned,global,owner`);
    const { owned_id: ownedId, global_id: globalId, owner_id: ownerId } = legacy.rows[0]!;

    await migrate(harness.database);

    const migrated = await harness.database.query<{ id: string; visibility: string }>(
      'SELECT id,visibility FROM compute_targets ORDER BY name',
    );
    expect(migrated.rows).toEqual([
      { id: globalId, visibility: 'public' },
      { id: ownedId, visibility: 'private' },
    ]);
    const sharing = await harness.database.query<{ table: string | null }>(
      "SELECT to_regclass('compute_target_projects')::text AS table",
    );
    expect(sharing.rows[0]!.table).toBeNull();
    // An owner is no longer a site's alone, and a private computer needs one.
    await harness.database.query('UPDATE compute_targets SET owner_user_id=$2 WHERE id=$1', [globalId, ownerId]);
    await expect(
      harness.database.query(
        "UPDATE compute_targets SET owner_user_id=NULL,visibility='private' WHERE id=$1",
        [globalId],
      ),
    ).rejects.toThrow('target_private_owner');
  });
});
