import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationChannel, NotificationTestResult } from '@mmt/contracts';
import { createNotificationSenders, type SmtpSettings } from '@mmt/platform';
import { jobCreateSchema } from '../src/domain/validation.js';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { NotificationDispatcher } from '../src/services/notificationDispatcher.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';

const SMTP_USER = 'mailer';
const SMTP_PASSWORD = 'smtp-integration-password';
const SMTP_FROM = 'mado ML Tracking <mmt@example.com>';
const recipients = ['ml-team@example.com', 'oncall@example.com'];

interface ReceivedMail {
  to: string[];
  data: string;
}

/** A loopback SMTP server that accepts the test credentials and records each message. */
async function startSmtpServer() {
  const received: ReceivedMail[] = [];
  const server = new SMTPServer({
    // The test server has no trusted certificate; TLS verification is covered by the unit tests.
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username === SMTP_USER && auth.password === SMTP_PASSWORD)
        callback(null, { user: auth.username });
      else callback(new Error('Invalid credentials'));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          to: session.envelope.rcptTo.map((recipient) => recipient.address),
          data: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  return {
    received,
    url: `smtp://${SMTP_USER}:${SMTP_PASSWORD}@127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(resolve)),
  };
}

describe.skipIf(!testDatabaseUrl)('メール通知（テスト用SMTPサーバー・独立PostgreSQL）', () => {
  let harness: Harness;
  let smtpServer: Awaited<ReturnType<typeof startSmtpServer>>;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    smtpServer = await startSmtpServer();
  });
  afterEach(async () => {
    await smtpServer.close();
  });
  afterAll(async () => {
    await harness?.close();
  });

  /** The same database and stores as the harness, with MMT_SMTP_URL and MMT_SMTP_FROM set. */
  function smtpApplication() {
    const config = loadConfig({
      MMT_DATABASE_URL: testDatabaseUrl,
      AUTH_MODE: 'development',
      MMT_ALLOW_LOCAL_EXECUTOR: 'true',
      MMT_ALLOW_SEED: 'true',
      MMT_SMTP_URL: smtpServer.url,
      MMT_SMTP_FROM: SMTP_FROM,
    });
    return {
      config,
      application: createApplication({
        config,
        database: harness.database,
        stores: harness.stores,
      }),
    };
  }

  async function createEmailChannel(app: Harness['app'], cookie: string) {
    return entity<NotificationChannel>(
      await request(app, '/api/notification-channels', {
        method: 'POST',
        cookie,
        body: { kind: 'email', name: 'ml-team-mail', recipients },
      }),
    );
  }

  async function testSend(app: Harness['app'], cookie: string, channelId: string) {
    return entity<NotificationTestResult>(
      await request(app, `/api/notification-channels/${channelId}/test`, {
        method: 'POST',
        cookie,
      }),
      200,
    );
  }

  /** A failed training Run whose completion queues one run.failed notification. */
  async function failRun(fixture: Awaited<ReturnType<typeof executionFixture>>) {
    const run = await fixture.newRun('train-large', 'training');
    const editorSession = fixture.editor.cookie.slice(fixture.editor.cookie.indexOf('=') + 1);
    const editor = (await harness.services.auth.authenticate({ session: editorSession }))!;
    const worker = (await harness.services.auth.authenticate({ bearer: fixture.workerToken }))!;
    const job = await harness.services.jobs.create(
      editor,
      fixture.project.id,
      jobCreateSchema.parse({ runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] }),
    );
    const claimed = await harness.services.worker.claim(worker, { workerId: 'mail-worker' });
    await harness.services.worker.complete(worker, job.id, {
      leaseId: claimed!.job.leaseId!,
      status: 'failed',
      exitCode: 1,
    });
    return run;
  }

  it('MMT_SMTP_URLがあればemail channelは送信設定済みになり、テスト送信が宛先全員へ届く', async () => {
    const { application } = smtpApplication();
    const administrator = await login(harness);
    const channel = await createEmailChannel(application.app, administrator.cookie);
    expect(channel).toMatchObject({ kind: 'email', recipients, configured: true });

    const result = await testSend(application.app, administrator.cookie, channel.id);
    expect(result).toMatchObject({ delivered: true, error: null });
    expect(smtpServer.received).toHaveLength(1);
    expect(smtpServer.received[0]!.to).toEqual(recipients);
    expect(smtpServer.received[0]!.data).toMatch(
      new RegExp(`^X-MMT-Delivery: ${result.sentDeliveryId}$`, 'im'),
    );
  });

  it('Runの失敗はoutboxからメールで届き、本文に実行スナップショットやtokenを含めない', async () => {
    const { config } = smtpApplication();
    const fixture = await executionFixture(harness);
    const channel = await createEmailChannel(harness.app, fixture.administrator.cookie);
    await entity(
      await request(harness.app, `${fixture.basePath}/notification-rules`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { channelId: channel.id, eventTypes: ['run.failed'] },
      }),
    );
    const run = await failRun(fixture);

    const dispatcher = new NotificationDispatcher(harness.database, {
      senders: createNotificationSenders({ smtp: config.smtp as SmtpSettings }),
      environment: {},
    });
    expect(await dispatcher.dispatchBatch()).toBe(1);
    const outbox = await harness.database.query<{ status: string; last_error: string | null }>(
      'SELECT status,last_error FROM notification_outbox',
    );
    expect(outbox.rows).toEqual([{ status: 'delivered', last_error: null }]);
    expect(smtpServer.received).toHaveLength(1);
    const mail = smtpServer.received[0]!;
    expect(mail.to).toEqual(recipients);
    expect(mail.data).toContain(`Run: ${run.name}`);
    for (const forbidden of ['executionSnapshot', fixture.workerToken, SMTP_PASSWORD])
      expect(mail.data).not.toContain(forbidden);
  });

  it('MMT_SMTP_URLが無ければemail channelは未設定と表示され、送信はemail_sender_unavailableで失敗する', async () => {
    const administrator = await login(harness);
    const channel = await createEmailChannel(harness.app, administrator.cookie);
    expect(channel).toMatchObject({ kind: 'email', configured: false });
    expect(await testSend(harness.app, administrator.cookie, channel.id)).toEqual({
      delivered: false,
      sentDeliveryId: null,
      error: 'email_sender_unavailable',
    });
    expect(smtpServer.received).toHaveLength(0);
  });

  it('MMT_SMTP_URLが不正、またはMMT_SMTP_FROMが無ければ起動を止め、パスワードを出さない', () => {
    for (const smtpSettings of [
      {
        MMT_SMTP_URL: `http://${SMTP_USER}:${SMTP_PASSWORD}@127.0.0.1:25`,
        MMT_SMTP_FROM: SMTP_FROM,
      },
      { MMT_SMTP_URL: `smtp://${SMTP_USER}:${SMTP_PASSWORD}@127.0.0.1:25` },
    ]) {
      let message = '';
      try {
        loadConfig({
          MMT_DATABASE_URL: testDatabaseUrl,
          AUTH_MODE: 'development',
          ...smtpSettings,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^MMT_SMTP_(URL|FROM) /);
      expect(message).not.toContain(SMTP_PASSWORD);
    }
  });
});
