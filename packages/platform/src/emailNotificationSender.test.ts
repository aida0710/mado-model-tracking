import type { AddressInfo } from 'node:net';
import nodemailer, { type Transporter } from 'nodemailer';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationEvent } from '@mmt/contracts';
import {
  createEmailNotificationSender,
  emailMessage,
  parseSmtpSettings,
  type SmtpSettings,
} from './emailNotificationSender.js';
import {
  createNotificationSenders,
  NotificationSendError,
  type NotificationDestination,
} from './notificationSenders.js';

const failedRunEvent: NotificationEvent = {
  schemaVersion: 1,
  id: '5d0f8f0e-6a55-4a3e-9d6c-1f0f3c1e2a10',
  type: 'run.failed',
  occurredAt: '2026-10-08T00:10:00.000Z',
  title: 'Runが失敗しました: train-large',
  project: { id: 'p1', name: 'Speech' },
  run: {
    id: 'r1',
    name: 'train-large',
    kind: 'training',
    status: 'failed',
    experimentId: 'e1',
    experimentName: 'ASR',
    error: `CUDA out of memory${'x'.repeat(5000)}`,
    startedAt: '2026-10-08T00:00:00.000Z',
    endedAt: '2026-10-08T00:10:00.000Z',
  },
  details: { jobId: 'j1' },
  url: 'http://127.0.0.1:5182/projects/p1/runs/r1',
};

const mailChannel: NotificationDestination = {
  kind: 'email',
  name: 'ml-team-mail',
  url: null,
  secret: null,
  recipients: ['ml-team@example.com', 'oncall@example.com'],
};

const smtp: SmtpSettings = {
  url: 'smtp://127.0.0.1:1',
  from: 'Mado Model Tracking <mmt@example.com>',
};

interface JsonMail {
  from: { address: string; name: string };
  to: { address: string }[];
  subject: string;
  text: string;
  headers: Record<string, string>;
}

/** A sender over nodemailer's JSON transport, with the composed messages it produced. */
function jsonSender() {
  const messages: JsonMail[] = [];
  const transporter = nodemailer.createTransport({ jsonTransport: true });
  const recording = {
    async sendMail(mail: Parameters<typeof transporter.sendMail>[0]) {
      const info = await transporter.sendMail(mail);
      messages.push(JSON.parse(info.message) as JsonMail);
      return info;
    },
  } as unknown as Transporter;
  return { sender: createEmailNotificationSender({ smtp, transporter: recording }), messages };
}

async function sendError(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(NotificationSendError);
  return (error as NotificationSendError).code;
}

describe('emailNotificationSender', () => {
  it('Slackと同じeventから件名・本文を作り、channelの宛先とMMT_SMTP_FROMで送る', async () => {
    const { sender, messages } = jsonSender();
    const { deliveryId } = await sender.send(mailChannel, failedRunEvent);
    expect(messages).toHaveLength(1);
    const [mail] = messages;
    expect(mail!.from).toEqual({ address: 'mmt@example.com', name: 'Mado Model Tracking' });
    expect(mail!.to.map((recipient) => recipient.address)).toEqual(mailChannel.recipients);
    expect(mail!.subject).toBe('[Speech] Runが失敗しました: train-large');
    expect(mail!.text).toContain('Run: train-large');
    expect(mail!.text).toContain('実験: ASR');
    expect(mail!.text).toContain('種別・状態: training / failed');
    expect(mail!.text).toContain('jobId: j1');
    expect(mail!.text).toContain(failedRunEvent.url);
    expect(mail!.text).toContain('CUDA out of memory');
    // The 5000-character error is cut so the body stays a notification, not a log.
    expect(mail!.text.length).toBeLessThan(3000);
    expect(mail!.headers).toMatchObject({
      'X-MMT-Event': 'run.failed',
      'X-MMT-Event-Id': failedRunEvent.id,
      'X-MMT-Delivery': deliveryId,
    });
  });

  it('eventに紛れた実行スナップショット・環境変数・tokenは本文にも件名にも入れない', async () => {
    const { sender, messages } = jsonSender();
    const leakyEvent = {
      ...failedRunEvent,
      executionSnapshot: { image: 'registry.example/secret-image' },
      environment: { HF_TOKEN: 'hf_leaked_value' },
      run: { ...failedRunEvent.run!, token: 'mmt_leaked_token', parameters: { lr: 'leaked-lr' } },
    } as NotificationEvent;
    await sender.send(mailChannel, leakyEvent);
    const composed = JSON.stringify(messages[0]);
    for (const leaked of ['secret-image', 'hf_leaked_value', 'mmt_leaked_token', 'leaked-lr'])
      expect(composed).not.toContain(leaked);
  });

  it('Run名の改行は件名で空白にし、ヘッダを増やせない', () => {
    const { subject } = emailMessage({
      ...failedRunEvent,
      title: 'Runが失敗しました: a\r\nBcc: attacker@example.com',
    });
    expect(subject).toBe('[Speech] Runが失敗しました: a Bcc: attacker@example.com');
  });

  it('宛先が空・50件超・形式違反なら送らずにnotification_recipients_invalidにする', async () => {
    const { sender, messages } = jsonSender();
    const tooMany = Array.from({ length: 51 }, (_, index) => `user${index}@example.com`);
    for (const recipients of [
      [],
      tooMany,
      ['not-an-address'],
      ['a@example.com, b@example.com'],
      ['Team <team@example.com>'],
      ['a@example.com\r\nBcc: attacker@example.com'],
    ])
      expect(await sendError(sender.send({ ...mailChannel, recipients }, failedRunEvent))).toBe(
        'notification_recipients_invalid',
      );
    expect(messages).toHaveLength(0);
  });

  it('送信が締め切りまでに終わらなければnotification_timeoutにする', async () => {
    const hanging = { sendMail: () => new Promise(() => undefined) } as unknown as Transporter;
    const sender = createEmailNotificationSender({ smtp, transporter: hanging, deadlineMs: 50 });
    expect(await sendError(sender.send(mailChannel, failedRunEvent))).toBe('notification_timeout');
  });

  it('createNotificationSendersはSMTPの設定があるときだけemailを持つ', () => {
    expect(createNotificationSenders().email).toBeUndefined();
    expect(createNotificationSenders({ smtp: null }).email).toBeUndefined();
    expect(createNotificationSenders({ smtp }).email).toBeDefined();
  });
});

describe('parseSmtpSettings', () => {
  it('MMT_SMTP_URLが無ければnullで、メール送信を有効にしない', () => {
    expect(parseSmtpSettings({ url: undefined, from: undefined })).toBeNull();
  });

  it('smtp/smtpsのURLと送信元を受け付ける', () => {
    expect(
      parseSmtpSettings({ url: 'smtps://mailer:pw@mail.example.com:465', from: 'mmt@example.com' }),
    ).toEqual({ url: 'smtps://mailer:pw@mail.example.com:465', from: 'mmt@example.com' });
    expect(
      parseSmtpSettings({ url: 'smtp://mail.example.com', from: 'MMT <mmt@example.com>' }),
    ).toMatchObject({ from: 'MMT <mmt@example.com>' });
  });

  it('不正な設定は変数名だけを示して起動を止め、パスワードを出さない', () => {
    for (const [settings, message] of [
      [{ url: 'https://mailer:hunter2@mail.example.com', from: 'a@example.com' }, 'MMT_SMTP_URL'],
      [
        {
          url: 'smtp://mailer:hunter2@mail.example.com?tls.rejectUnauthorized=false',
          from: 'a@example.com',
        },
        'MMT_SMTP_URL',
      ],
      [{ url: 'smtp://mailer:hunter2@mail.example.com', from: undefined }, 'MMT_SMTP_FROM'],
      [{ url: 'smtp://mailer:hunter2@mail.example.com', from: 'not-an-address' }, 'MMT_SMTP_FROM'],
      [{ url: undefined, from: 'mmt@example.com' }, 'MMT_SMTP_URL'],
    ] as const) {
      let error: Error | undefined;
      try {
        parseSmtpSettings(settings);
      } catch (failure) {
        error = failure as Error;
      }
      expect(error?.message).toContain(message);
      expect(error?.message).not.toContain('hunter2');
    }
  });
});

describe('emailNotificationSender（テスト用SMTPサーバー）', () => {
  const servers: SMTPServer[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  });

  interface ReceivedMail {
    user: string | undefined;
    from: string | undefined;
    to: string[];
    data: string;
  }

  async function startServer(options: SMTPServerOptions = {}) {
    const received: ReceivedMail[] = [];
    const server = new SMTPServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      logger: false,
      onAuth(auth, _session, callback) {
        if (auth.username === 'mailer' && auth.password === 'smtp-test-password')
          callback(null, { user: auth.username });
        else callback(new Error('Invalid credentials'));
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          received.push({
            user: session.user as string | undefined,
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined,
            to: session.envelope.rcptTo.map((recipient) => recipient.address),
            data: Buffer.concat(chunks).toString('utf8'),
          });
          callback();
        });
      },
      ...options,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.server.address() as AddressInfo;
    return { port, received };
  }

  it('URLの認証情報でAUTHし、全宛先へ届ける', async () => {
    const { port, received } = await startServer();
    const sender = createEmailNotificationSender({
      smtp: { url: `smtp://mailer:smtp-test-password@127.0.0.1:${port}`, from: 'mmt@example.com' },
    });
    await sender.send(mailChannel, failedRunEvent);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      user: 'mailer',
      from: 'mmt@example.com',
      to: mailChannel.recipients,
    });
    // nodemailer normalizes the header name's case on the wire.
    expect(received[0]!.data).toMatch(/^X-MMT-Event: run\.failed$/im);
  });

  it('認証に失敗したらnotification_smtp_auth_failedにする', async () => {
    const { port } = await startServer();
    const sender = createEmailNotificationSender({
      smtp: { url: `smtp://mailer:wrong@127.0.0.1:${port}`, from: 'mmt@example.com' },
    });
    expect(await sendError(sender.send(mailChannel, failedRunEvent))).toBe(
      'notification_smtp_auth_failed',
    );
  });

  it('全宛先が拒否されたらnotification_smtp_recipients_rejectedにする', async () => {
    const { port } = await startServer({
      authOptional: true,
      onRcptTo(_address, _session, callback) {
        callback(Object.assign(new Error('No such user'), { responseCode: 550 }));
      },
    });
    const sender = createEmailNotificationSender({
      smtp: { url: `smtp://127.0.0.1:${port}`, from: 'mmt@example.com' },
    });
    expect(await sendError(sender.send(mailChannel, failedRunEvent))).toBe(
      'notification_smtp_recipients_rejected',
    );
  });

  it('STARTTLSの証明書は既定で検証し、検証できなければ送らない', async () => {
    // smtp-server offers STARTTLS with its built-in certificate, which no CA vouches for.
    const { port, received } = await startServer({ disabledCommands: [], authOptional: true });
    const sender = createEmailNotificationSender({
      smtp: { url: `smtp://127.0.0.1:${port}`, from: 'mmt@example.com' },
    });
    // nodemailer reports a rejected certificate as a socket error, not as ETLS.
    expect(await sendError(sender.send(mailChannel, failedRunEvent))).toBe(
      'notification_destination_unavailable',
    );
    expect(received).toHaveLength(0);
  });

  it('接続先が応答しなければ締め切りでnotification_timeoutにする', async () => {
    // The greeting never comes: the server holds every connection without answering.
    const { createServer } = await import('node:net');
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = silent.address() as AddressInfo;
      const sender = createEmailNotificationSender({
        smtp: { url: `smtp://127.0.0.1:${port}`, from: 'mmt@example.com' },
        deadlineMs: 200,
      });
      const started = Date.now();
      expect(await sendError(sender.send(mailChannel, failedRunEvent))).toBe(
        'notification_timeout',
      );
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      silent.close();
    }
  });
});
