import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationEvent } from '@mmt/contracts';
import {
  createNotificationSenders,
  isNotificationChannelConfigured,
  NotificationSendError,
  resolveNotificationDestination,
  type NotificationDestination,
} from './notificationSenders.js';

const failedRunEvent: NotificationEvent = {
  schemaVersion: 1,
  id: '5d0f8f0e-6a55-4a3e-9d6c-1f0f3c1e2a10',
  type: 'run.failed',
  occurredAt: '2026-10-08T00:00:00.000Z',
  title: 'Runが失敗しました: train <large>',
  project: { id: 'p1', name: 'Speech & Audio' },
  run: {
    id: 'r1',
    name: 'train <large>',
    kind: 'training',
    status: 'failed',
    experimentId: 'e1',
    experimentName: 'ASR',
    error: 'x'.repeat(2000),
    startedAt: '2026-10-08T00:00:00.000Z',
    endedAt: '2026-10-08T00:10:00.000Z',
  },
  details: {},
  url: 'http://127.0.0.1:5182/projects/p1/runs/r1',
};

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function capturingFetcher(status = 200): { fetcher: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    });
    return new Response('ok', { status });
  };
  return { fetcher, requests };
}

const slackChannel: NotificationDestination = {
  kind: 'slack_webhook',
  name: 'ml-alerts',
  url: 'https://hooks.slack.example/services/T/B/X',
  secret: null,
  recipients: [],
};
const webhookChannel: NotificationDestination = {
  kind: 'webhook',
  name: 'ops',
  url: 'https://ops.example/hooks/mmt',
  secret: 'unit-test-signing-secret',
  recipients: [],
};

const servers: Server[] = [];
async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('通知の送信部品', () => {
  it('Slackにはfallbackのtextとblocksを送り、mrkdwnの制御文字をescapeしてエラーを短くする', async () => {
    const { fetcher, requests } = capturingFetcher();
    const result = await createNotificationSenders({ fetcher }).slack_webhook!.send(
      slackChannel,
      failedRunEvent,
    );
    expect(result.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests).toHaveLength(1);
    const payload = JSON.parse(requests[0]!.body) as { text: string; blocks: unknown[] };
    expect(payload.text).toBe('[Speech & Audio] Runが失敗しました: train <large>');
    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).toContain('<http://127.0.0.1:5182/projects/p1/runs/r1|');
    expect(serialized).toContain('train &lt;large&gt;');
    expect(serialized).toContain('Speech &amp; Audio');
    expect(serialized).not.toContain('x'.repeat(501));
  });

  it('Webhookは本文のHMAC-SHA256とevent id・delivery idをheaderに付ける', async () => {
    const { fetcher, requests } = capturingFetcher();
    const result = await createNotificationSenders({ fetcher }).webhook!.send(
      webhookChannel,
      failedRunEvent,
    );
    const sent = requests[0]!;
    expect(JSON.parse(sent.body)).toEqual(failedRunEvent);
    const expected = createHmac('sha256', webhookChannel.secret!).update(sent.body).digest('hex');
    expect(sent.headers['X-MMT-Signature']).toBe(`sha256=${expected}`);
    expect(sent.headers['X-MMT-Event-Id']).toBe(failedRunEvent.id);
    expect(sent.headers['X-MMT-Event']).toBe('run.failed');
    expect(sent.headers['X-MMT-Delivery']).toBe(result.deliveryId);
    expect(sent.body).not.toContain(webhookChannel.secret!);
  });

  it('2xx以外は状態コードだけを含むcodeで失敗し、応答本文やURLを含めない', async () => {
    const { fetcher } = capturingFetcher(500);
    const failure = createNotificationSenders({ fetcher }).webhook!.send(
      webhookChannel,
      failedRunEvent,
    );
    await expect(failure).rejects.toThrow(NotificationSendError);
    await expect(failure).rejects.toMatchObject({ code: 'notification_http_500' });
  });

  it('deadlineを超えた送信はnotification_timeoutで打ち切る', async () => {
    const url = await listen(() => {
      // Never responds.
    });
    const senders = createNotificationSenders({ deadlineMs: 100 });
    const started = Date.now();
    await expect(
      senders.slack_webhook!.send({ ...slackChannel, url }, failedRunEvent),
    ).rejects.toMatchObject({ code: 'notification_timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('redirectを追わず、転送先へ本文を送らない', async () => {
    let redirectedRequests = 0;
    const elsewhere = await listen((_request, response) => {
      redirectedRequests++;
      response.end('ok');
    });
    const url = await listen((_request, response) => {
      response.writeHead(307, { Location: `${elsewhere}/steal` }).end();
    });
    await expect(
      createNotificationSenders().webhook!.send({ ...webhookChannel, url }, failedRunEvent),
    ).rejects.toMatchObject({ code: 'notification_redirect_refused' });
    expect(redirectedRequests).toBe(0);
  });

  it('http(s)以外や認証情報入りのURLは送らずに失敗する', async () => {
    const { fetcher, requests } = capturingFetcher();
    const senders = createNotificationSenders({ fetcher });
    for (const url of ['file:///etc/passwd', 'https://user:pass@hooks.example/x', 'not a url'])
      await expect(
        senders.slack_webhook!.send({ ...slackChannel, url }, failedRunEvent),
      ).rejects.toMatchObject({ code: 'notification_url_invalid' });
    expect(requests).toHaveLength(0);
  });

  it('環境変数が未設定のchannelは未設定として扱い、値はchannel設定に残さない', () => {
    const settings = {
      kind: 'webhook' as const,
      name: 'ops',
      urlEnv: 'MMT_NOTIFICATION_OPS_URL',
      secretEnv: 'MMT_NOTIFICATION_OPS_SECRET',
      recipients: [],
    };
    const environment = { MMT_NOTIFICATION_OPS_URL: 'https://ops.example/hook' };
    expect(isNotificationChannelConfigured(settings, environment)).toBe(false);
    expect(() => resolveNotificationDestination(settings, environment)).toThrow(
      'notification_channel_unconfigured',
    );
    const resolved = resolveNotificationDestination(settings, {
      ...environment,
      MMT_NOTIFICATION_OPS_SECRET: 'secret',
    });
    expect(resolved).toMatchObject({ url: 'https://ops.example/hook', secret: 'secret' });
  });
});
