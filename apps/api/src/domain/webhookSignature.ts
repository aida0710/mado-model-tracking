import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  HOOK_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  type HookWebhookSignature,
} from '@mmt/contracts';

// The headers each signature style sends (GitHub's documented names, and this API's own).
export const WEBHOOK_HEADERS = {
  github: { signature: 'x-hub-signature-256', delivery: 'x-github-delivery' },
  mmt: { signature: 'x-mmt-signature', delivery: 'x-mmt-delivery' },
} as const;

function hmacHex(secret: string, message: Buffer): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

function sameHex(expected: string, received: string): boolean {
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(received, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * github: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, body)>`.
 * mmt: `X-MMT-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, with the
 * timestamp within the tolerance so a captured request cannot be replayed later.
 */
export function verifyWebhookSignature(request: {
  style: HookWebhookSignature;
  secret: string;
  header: string | undefined;
  body: Buffer;
  nowSeconds: number;
}): boolean {
  const { header } = request;
  if (!header) return false;
  if (request.style === 'github') {
    const received = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())?.[1];
    return !!received && sameHex(hmacHex(request.secret, request.body), received.toLowerCase());
  }
  const parts = new Map(
    header.split(',').map((part) => {
      const [key, ...value] = part.trim().split('=');
      return [key, value.join('=')] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const received = parts.get('v1');
  if (!Number.isInteger(timestamp) || !received || !/^[0-9a-f]{64}$/i.test(received)) return false;
  if (Math.abs(request.nowSeconds - timestamp) > HOOK_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS)
    return false;
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`), request.body]);
  return sameHex(hmacHex(request.secret, signed), received.toLowerCase());
}
