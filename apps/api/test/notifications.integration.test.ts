import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  NotificationChannel,
  NotificationDelivery,
  NotificationEvent,
  NotificationRule,
  NotificationTestResult,
  Run,
} from '@mmt/contracts';
import {
  NotificationSendError,
  type NotificationDestination,
  type NotificationSenders,
} from '@mmt/platform';
import { transaction } from '../src/db/database.js';
import { jobCreateSchema } from '../src/domain/validation.js';
import { createApplication } from '../src/app.js';
import {
  NOTIFICATION_MAX_ATTEMPTS,
  NotificationDispatcher,
} from '../src/services/notificationDispatcher.js';
import { NotificationRunHandler } from '../src/services/notificationRunHandler.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

const environment = {
  MMT_NOTIFICATION_SLACK_URL: 'https://hooks.slack.example/services/T/B/X',
  MMT_NOTIFICATION_OPS_URL: 'https://ops.example/hooks/mmt',
  MMT_NOTIFICATION_OPS_SECRET: 'integration-signing-secret',
};

interface SentNotification {
  destination: NotificationDestination;
  event: NotificationEvent;
}

/** Records sends; `failWith` makes every send fail with that code. */
function recordingSenders(options: { failWith?: string } = {}) {
  const sent: SentNotification[] = [];
  const sender = {
    async send(destination: NotificationDestination, event: NotificationEvent) {
      if (options.failWith) throw new NotificationSendError(options.failWith);
      sent.push({ destination, event });
      return { deliveryId: crypto.randomUUID() };
    },
  };
  const senders: NotificationSenders = { slack_webhook: sender, webhook: sender };
  return { senders, sent };
}

describe.skipIf(!testDatabaseUrl)('通知チャネル・ルール・送信outbox（独立PostgreSQL）', () => {
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

  function dispatcher(senders: NotificationSenders): NotificationDispatcher {
    return new NotificationDispatcher(harness.database, { senders, environment });
  }

  async function setup() {
    const fixture = await executionFixture(harness);
    const projectAdmin = await login(harness, 'project-admin@localhost');
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${projectAdmin.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'admin' },
      }),
      200,
    );
    const workerPrincipal = (await harness.services.auth.authenticate({
      bearer: fixture.workerToken,
    }))!;
    const editorSession = fixture.editor.cookie.slice(fixture.editor.cookie.indexOf('=') + 1);
    const editorPrincipal = (await harness.services.auth.authenticate({
      session: editorSession,
    }))!;
    return { ...fixture, projectAdmin, workerPrincipal, editorPrincipal };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  async function createChannel(
    fixture: Setup,
    body: Record<string, unknown> = {
      kind: 'slack_webhook',
      name: 'ml-alerts',
      urlEnv: 'MMT_NOTIFICATION_SLACK_URL',
    },
  ): Promise<NotificationChannel> {
    return entity<NotificationChannel>(
      await request(harness.app, '/api/notification-channels', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body,
      }),
    );
  }

  async function createRule(
    fixture: Setup,
    body: Record<string, unknown>,
  ): Promise<NotificationRule> {
    return entity<NotificationRule>(
      await request(harness.app, `${fixture.basePath}/notification-rules`, {
        method: 'POST',
        cookie: fixture.projectAdmin.cookie,
        body,
      }),
    );
  }

  /** Starts a Job for a new Run and returns the worker's completion for it. */
  async function claimedJob(fixture: Setup, name = 'Train', kind: Run['kind'] = 'training') {
    const run = await fixture.newRun(name, kind);
    const job = await harness.services.jobs.create(
      fixture.editorPrincipal,
      fixture.project.id,
      jobCreateSchema.parse({ runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] }),
    );
    const claimed = await harness.services.worker.claim(fixture.workerPrincipal, {
      workerId: 'notification-worker',
    });
    // Only failed is used: the worker reports it with a non-zero exit code.
    const completeFailed = () =>
      harness.services.worker.complete(fixture.workerPrincipal, job.id, {
        leaseId: claimed!.job.leaseId!,
        status: 'failed',
        exitCode: 1,
      });
    return { run, job, completeFailed };
  }

  async function outboxRows() {
    return (
      await harness.database.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        event_type: string;
        event: NotificationEvent;
      }>(
        'SELECT status,attempts,last_error,event_type,event FROM notification_outbox ORDER BY created_at',
      )
    ).rows;
  }

  async function makeDue(): Promise<void> {
    await harness.database.query(
      "UPDATE notification_outbox SET next_attempt_at=now() WHERE status='pending'",
    );
  }

  it('workerのfailed completeで1件積み、再送completeでは増えず、送信すると本文にsnapshotやtokenが無い', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture);
    await createRule(fixture, { channelId: channel.id, eventTypes: ['run.failed'] });
    const { run, completeFailed } = await claimedJob(fixture);
    await completeFailed();
    await completeFailed();

    const queued = await outboxRows();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'pending', event_type: 'run.failed' });

    const { senders, sent } = recordingSenders();
    expect(await dispatcher(senders).dispatchBatch()).toBe(1);
    expect(sent).toHaveLength(1);
    const { event, destination } = sent[0]!;
    expect(destination.url).toBe(environment.MMT_NOTIFICATION_SLACK_URL);
    expect(event).toMatchObject({
      type: 'run.failed',
      project: { id: fixture.project.id, name: 'Test Project' },
      run: { id: run.id, status: 'failed', kind: 'training', experimentName: 'Test Experiment' },
      url: `${harness.config.webOrigin}/projects/${fixture.project.id}/runs/${run.id}`,
    });
    const body = JSON.stringify(event);
    for (const forbidden of ['executionSnapshot', 'parameters', 'environment', fixture.workerToken])
      expect(body).not.toContain(forbidden);

    const deliveries = await entity<{ items: NotificationDelivery[] }>(
      await request(harness.app, `${fixture.basePath}/notification-deliveries?limit=10`, {
        cookie: fixture.projectAdmin.cookie,
      }),
      200,
    );
    expect(deliveries.items).toEqual([
      expect.objectContaining({
        status: 'delivered',
        attempts: 1,
        eventType: 'run.failed',
        runId: run.id,
        channelName: 'ml-alerts',
        lastError: null,
      }),
    ]);
    expect(deliveries.items[0]!.sentDeliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await dispatcher(senders).dispatchBatch()).toBe(0);
  });

  it('終端遷移がrollbackされると通知も残らない', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture);
    await createRule(fixture, { channelId: channel.id, eventTypes: ['run.failed'] });
    const run = await fixture.newRun();
    const handler = new NotificationRunHandler({ webOrigin: harness.config.webOrigin });
    const rollback = new Error('rollback the terminal transition');
    await expect(
      transaction(harness.database, async (connection) => {
        await handler.handle(connection, {
          previousStatus: 'running',
          run: { ...run, status: 'failed', endedAt: new Date().toISOString() },
        });
        const inside = await connection.query(
          'SELECT count(*)::int AS count FROM notification_outbox',
        );
        expect(inside.rows[0].count).toBe(1);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('filterに合わないRun・購読していない種別・無効なchannelとruleには積まない', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture);
    const otherExperiment = await entity<{ id: string }>(
      await request(harness.app, `${fixture.basePath}/experiments`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Other Experiment' },
      }),
    );
    await createRule(fixture, {
      channelId: channel.id,
      eventTypes: ['run.failed'],
      filter: { runKinds: ['evaluation'] },
    });
    await createRule(fixture, {
      channelId: channel.id,
      eventTypes: ['run.failed'],
      filter: { experimentIds: [otherExperiment.id] },
    });
    await createRule(fixture, {
      channelId: channel.id,
      eventTypes: ['run.failed'],
      filter: { automationOnly: true },
    });
    await createRule(fixture, { channelId: channel.id, eventTypes: ['run.finished'] });
    await createRule(fixture, {
      channelId: channel.id,
      eventTypes: ['run.failed'],
      enabled: false,
    });
    const disabledChannel = await createChannel(fixture, {
      kind: 'slack_webhook',
      name: 'paused',
      urlEnv: 'MMT_NOTIFICATION_SLACK_URL',
      enabled: false,
    });
    await createRule(fixture, { channelId: disabledChannel.id, eventTypes: ['run.failed'] });

    const { completeFailed } = await claimedJob(fixture, 'Train', 'training');
    await completeFailed();
    expect(await outboxRows()).toHaveLength(0);
  });

  it('run.finishedはruleで選んだときだけ積み、run.canceledも種別として届く', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture);
    await createRule(fixture, {
      channelId: channel.id,
      eventTypes: ['run.finished', 'run.canceled'],
    });
    const finished = await fixture.newRun('Finished');
    await entity(
      await request(harness.app, `${fixture.basePath}/runs/${finished.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { status: 'finished' },
      }),
      200,
    );
    const canceled = await fixture.newRun('Canceled');
    await entity(
      await request(harness.app, `${fixture.basePath}/runs/${canceled.id}`, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { status: 'canceled' },
      }),
      200,
    );
    expect((await outboxRows()).map((row) => row.event_type).sort()).toEqual([
      'run.canceled',
      'run.finished',
    ]);
  });

  it('積んだ後にchannelを無効にすると送らずにfailedにする', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture);
    await createRule(fixture, { channelId: channel.id, eventTypes: ['run.failed'] });
    const { completeFailed } = await claimedJob(fixture);
    await completeFailed();
    await entity(
      await request(harness.app, `/api/notification-channels/${channel.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: false },
      }),
      200,
    );
    const { senders, sent } = recordingSenders();
    expect(await dispatcher(senders).dispatchBatch()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await outboxRows()).toMatchObject([
      { status: 'failed', last_error: 'notification_channel_disabled', attempts: 1 },
    ]);
  });

  it('送信失敗はbackoffして再試行し、8回目の失敗でfailedにする', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture);
    await createRule(fixture, { channelId: channel.id, eventTypes: ['run.failed'] });
    const { completeFailed } = await claimedJob(fixture);
    await completeFailed();
    const failing = dispatcher(recordingSenders({ failWith: 'notification_http_500' }).senders);

    expect(await failing.dispatchBatch()).toBe(0);
    const afterFirst = await harness.database.query<{ status: string; wait: number }>(
      'SELECT status,extract(epoch FROM next_attempt_at-now())::float AS wait FROM notification_outbox',
    );
    expect(afterFirst.rows[0]!.status).toBe('pending');
    expect(afterFirst.rows[0]!.wait).toBeGreaterThan(3);
    // Not due yet: the backoff keeps the next dispatch from retrying immediately.
    expect(await failing.dispatchBatch()).toBe(0);
    expect((await outboxRows())[0]!.attempts).toBe(1);

    for (let attempt = 2; attempt <= NOTIFICATION_MAX_ATTEMPTS; attempt++) {
      await makeDue();
      await failing.dispatchBatch();
    }
    expect(await outboxRows()).toMatchObject([
      {
        status: 'failed',
        attempts: NOTIFICATION_MAX_ATTEMPTS,
        last_error: 'notification_http_500',
      },
    ]);
    await makeDue();
    const { senders, sent } = recordingSenders();
    expect(await dispatcher(senders).dispatchBatch()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('lease切れのsendingは別のdispatcherが回収し、古いleaseの結果では上書きしない', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture);
    await createRule(fixture, { channelId: channel.id, eventTypes: ['run.failed'] });
    const { completeFailed } = await claimedJob(fixture);
    await completeFailed();
    const staleDeliveryId = crypto.randomUUID();
    await harness.database.query(
      "UPDATE notification_outbox SET status='sending',delivery_id=$1,attempts=1,locked_at=now()-interval '10 minutes'",
      [staleDeliveryId],
    );
    const { senders, sent } = recordingSenders();
    expect(await dispatcher(senders).dispatchBatch()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await outboxRows()).toMatchObject([{ status: 'delivered', attempts: 2 }]);
    // The dispatcher that lost the lease reports a failure late; the delivered row stays.
    await harness.database.query(
      "UPDATE notification_outbox SET status='pending',last_error='late' WHERE delivery_id=$1",
      [staleDeliveryId],
    );
    expect(await outboxRows()).toMatchObject([{ status: 'delivered', last_error: null }]);
  });

  it('送信中で期限内のleaseは別のdispatcherが取らない', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture);
    await createRule(fixture, { channelId: channel.id, eventTypes: ['run.failed'] });
    const { completeFailed } = await claimedJob(fixture);
    await completeFailed();
    await harness.database.query(
      "UPDATE notification_outbox SET status='sending',delivery_id=gen_random_uuid(),locked_at=now()",
    );
    const { senders, sent } = recordingSenders();
    expect(await dispatcher(senders).dispatchBatch()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('email channelは保存・購読できるが、送信部品が無いのでemail_sender_unavailableでfailedにする', async () => {
    const fixture = await setup();
    const channel = await createChannel(fixture, {
      kind: 'email',
      name: 'ml-team-mail',
      recipients: ['ml-team@example.com'],
    });
    expect(channel).toMatchObject({ kind: 'email', urlEnv: null, configured: false });
    await createRule(fixture, { channelId: channel.id, eventTypes: ['run.failed'] });
    const { completeFailed } = await claimedJob(fixture);
    await completeFailed();
    expect(await dispatcher(recordingSenders().senders).dispatchBatch()).toBe(0);
    expect(await outboxRows()).toMatchObject([
      { status: 'failed', attempts: 1, last_error: 'email_sender_unavailable' },
    ]);
    const test = await entity<NotificationTestResult>(
      await request(harness.app, `/api/notification-channels/${channel.id}/test`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(test).toEqual({
      delivered: false,
      sentDeliveryId: null,
      error: 'email_sender_unavailable',
    });
  });

  it('channelの作成・変更・テストは全体管理者だけで、Project adminは403になり拒否が監査に残る', async () => {
    const fixture = await setup();
    const denied = await request(harness.app, '/api/notification-channels', {
      method: 'POST',
      cookie: fixture.projectAdmin.cookie,
      body: { kind: 'slack_webhook', name: 'mine', urlEnv: 'MMT_NOTIFICATION_SLACK_URL' },
    });
    expect(denied.status).toBe(403);
    const channel = await createChannel(fixture);
    for (const [method, path, body] of [
      ['PATCH', `/api/notification-channels/${channel.id}`, { enabled: false }],
      ['POST', `/api/notification-channels/${channel.id}/test`, undefined],
      ['GET', '/api/notification-channels', undefined],
    ] as const)
      expect(
        (await request(harness.app, path, { method, cookie: fixture.projectAdmin.cookie, body }))
          .status,
      ).toBe(403);
    const audit = await harness.database.query<{ action: string; outcome: string }>(
      "SELECT action,outcome FROM audit_events WHERE action LIKE 'notification.channel.%' ORDER BY occurred_at",
    );
    expect(audit.rows).toEqual([
      { action: 'notification.channel.create', outcome: 'denied' },
      { action: 'notification.channel.create', outcome: 'success' },
      { action: 'notification.channel.update', outcome: 'denied' },
      { action: 'notification.channel.test', outcome: 'denied' },
    ]);
  });

  it('channelは種類ごとの設定と環境変数名の接頭辞を検証し、値を保存しない', async () => {
    const fixture = await setup();
    for (const body of [
      { kind: 'webhook', name: 'unsigned', urlEnv: 'MMT_NOTIFICATION_OPS_URL' },
      { kind: 'slack_webhook', name: 'raw', urlEnv: 'MMT_DATABASE_URL' },
      { kind: 'email', name: 'empty-mail', recipients: [] },
      { kind: 'slack_webhook', name: 'url', url: 'https://hooks.slack.example/x' },
    ])
      expect(
        (
          await request(harness.app, '/api/notification-channels', {
            method: 'POST',
            cookie: fixture.administrator.cookie,
            body,
          })
        ).status,
      ).toBe(422);
    const webhook = await createChannel(fixture, {
      kind: 'webhook',
      name: 'ops',
      urlEnv: 'MMT_NOTIFICATION_OPS_URL',
      secretEnv: 'MMT_NOTIFICATION_OPS_SECRET',
      projectId: fixture.project.id,
    });
    // The harness environment does not define these variables.
    expect(webhook).toMatchObject({ projectId: fixture.project.id, configured: false });
    const duplicate = await request(harness.app, '/api/notification-channels', {
      method: 'POST',
      cookie: fixture.administrator.cookie,
      body: {
        kind: 'slack_webhook',
        name: 'ops',
        urlEnv: 'MMT_NOTIFICATION_SLACK_URL',
        projectId: fixture.project.id,
      },
    });
    expect(duplicate.status).toBe(409);
  });

  it('ruleはProject adminが作り、editorは403、別Projectのchannelは404、有効切替だけできる', async () => {
    const fixture = await setup();
    const globalChannel = await createChannel(fixture);
    const otherProject = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherChannel = await createChannel(fixture, {
      kind: 'slack_webhook',
      name: 'other-only',
      urlEnv: 'MMT_NOTIFICATION_SLACK_URL',
      projectId: otherProject.id,
    });
    const asEditor = await request(harness.app, `${fixture.basePath}/notification-rules`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { channelId: globalChannel.id, eventTypes: ['run.failed'] },
    });
    expect(asEditor.status).toBe(403);
    const foreign = await request(harness.app, `${fixture.basePath}/notification-rules`, {
      method: 'POST',
      cookie: fixture.projectAdmin.cookie,
      body: { channelId: otherChannel.id, eventTypes: ['run.failed'] },
    });
    expect(foreign.status).toBe(404);
    const usable = await entity<{ items: NotificationChannel[] }>(
      await request(harness.app, `${fixture.basePath}/notification-channels`, {
        cookie: fixture.projectAdmin.cookie,
      }),
      200,
    );
    expect(usable.items.map((channel) => channel.id)).toEqual([globalChannel.id]);

    const rule = await createRule(fixture, {
      channelId: globalChannel.id,
      eventTypes: ['run.failed', 'run.canceled'],
      filter: { runKinds: ['training'], automationOnly: false },
    });
    expect(rule).toMatchObject({
      enabled: true,
      eventTypes: ['run.failed', 'run.canceled'],
      filter: { runKinds: ['training'], automationOnly: false },
    });
    const switched = await entity<NotificationRule>(
      await request(harness.app, `${fixture.basePath}/notification-rules/${rule.id}`, {
        method: 'PATCH',
        cookie: fixture.projectAdmin.cookie,
        body: { enabled: false },
      }),
      200,
    );
    expect(switched.enabled).toBe(false);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/notification-rules/${rule.id}`, {
          method: 'PATCH',
          cookie: fixture.projectAdmin.cookie,
          body: { enabled: true, eventTypes: ['run.finished'] },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/notification-deliveries`, {
          cookie: fixture.editor.cookie,
        })
      ).status,
    ).toBe(403);
  });

  it('テスト送信は設定済みの送信部品で即時に送り、失敗はcodeだけを返す', async () => {
    const fixture = await setup();
    const { senders, sent } = recordingSenders();
    const application = createApplication({
      config: harness.config,
      database: harness.database,
      stores: harness.stores,
      environment: { ...environment, ARTIFACT_FILESYSTEM_ROOT: harness.artifactDirectory },
      notificationSenders: senders,
    });
    const channel = await createChannel(fixture);
    const result = await entity<NotificationTestResult>(
      await request(application.app, `/api/notification-channels/${channel.id}/test`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(result.delivered).toBe(true);
    expect(sent[0]!.event).toMatchObject({ type: 'notification.test', project: null, run: null });
    // The harness application has no MMT_NOTIFICATION_* variables, so the URL is unresolved.
    const unconfigured = await entity<NotificationTestResult>(
      await request(harness.app, `/api/notification-channels/${channel.id}/test`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(unconfigured).toEqual({
      delivered: false,
      sentDeliveryId: null,
      error: 'notification_channel_unconfigured',
    });
    expect(await outboxRows()).toHaveLength(0);
  });
});
