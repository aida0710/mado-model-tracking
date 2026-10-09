import { HOOK_PAYLOAD_MAX_BYTES, type HookTriggerRequest } from '@mmt/contracts';
import { parseJsonObject } from './formValues';
import { hooksTextTemplates } from '../i18n/hooks';

// 16 random bytes keep keys apart without crypto.randomUUID, which plain-http origins lack.
const START_KEY_BYTES = 16;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;
const BYTES_PER_KIB = 1024;

/**
 * A key for one intended start of a 'manual' hook. A resend with the same key (after a lost
 * response) returns the first start instead of starting again.
 */
export function createHookStartKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(START_KEY_BYTES)), (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, '0'),
  ).join('');
}

/**
 * The request of a manual start: the payload is an optional JSON object that reaches the Job as
 * trigger-payload.json, within the API's size limit.
 */
export function buildHookStartRequest(payload: string, idempotencyKey: string): HookTriggerRequest {
  if (!payload.trim()) return { idempotencyKey };
  const parsed = parseJsonObject(payload);
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > HOOK_PAYLOAD_MAX_BYTES)
    throw new Error(hooksTextTemplates.hookPayloadTooLarge(HOOK_PAYLOAD_MAX_BYTES / BYTES_PER_KIB));
  return { payload: parsed, idempotencyKey };
}
