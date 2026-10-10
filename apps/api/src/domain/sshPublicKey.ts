import { createHash } from 'node:crypto';
import { DomainError } from './errors.js';

// The launcher makes ed25519 keys only (ssh-keygen -t ed25519).
const KEY_TYPE = 'ssh-ed25519';
const PUBLIC_KEY_LINE = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})(?: ([^\r\n\0]{0,300}))?$/;
// An ed25519 key blob: the length-prefixed type name and the 32-byte key.
const ED25519_KEY_BYTES = 32;

function invalidPublicKey(): never {
  throw new DomainError(422, 'ssh-ed25519の公開鍵（1行）を送ってください', 'invalid_public_key');
}

function readString(blob: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > blob.length) invalidPublicKey();
  const length = blob.readUInt32BE(offset);
  const end = offset + 4 + length;
  if (end > blob.length) invalidPublicKey();
  return { value: blob.subarray(offset + 4, end), next: end };
}

/**
 * Checks an OpenSSH public key line and returns it with its fingerprint as `ssh-keygen -l` prints
 * it (SHA256 of the key blob, base64 without padding).
 */
export function parseSshPublicKey(line: string): { publicKey: string; fingerprint: string } {
  const match = PUBLIC_KEY_LINE.exec(line.trim());
  if (!match) invalidPublicKey();
  const blob = Buffer.from(match[2]!, 'base64');
  const type = readString(blob, 0);
  const key = readString(blob, type.next);
  if (type.value.toString() !== KEY_TYPE || key.value.length !== ED25519_KEY_BYTES || key.next !== blob.length)
    invalidPublicKey();
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { publicKey: line.trim(), fingerprint: `SHA256:${digest}` };
}
