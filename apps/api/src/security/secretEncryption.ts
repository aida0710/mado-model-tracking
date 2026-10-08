import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for secrets the server must read back (storage credentials, later OIDC tokens).
 * Each use passes its own key: a leaked or rotated key then exposes only that kind of secret,
 * and a row of one kind can never be decrypted as another.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
// 96-bit nonces are the GCM standard size; a fresh random one per encryption.
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
// Payload layout version, so a later format change can still read rows written today.
const FORMAT_VERSION = 1;
// Enough of the key's SHA-256 to tell keys apart without revealing anything about the key.
const KEY_ID_HEX_LENGTH = 16;

export interface SecretKey {
  /** Fingerprint stored next to each ciphertext to report a key change clearly. */
  id: string;
  material: Buffer;
}
export interface EncryptedSecret {
  keyId: string;
  /** version (1 byte) + nonce + ciphertext + tag. */
  payload: Buffer;
}

export class SecretKeyFormatError extends Error {
  constructor() {
    super('Secret key must be base64 of exactly 32 bytes');
    this.name = 'SecretKeyFormatError';
  }
}
/** The ciphertext was encrypted with another key, for example before a key rotation. */
export class SecretKeyMismatchError extends Error {
  constructor() {
    super('Secret was encrypted with a different key');
    this.name = 'SecretKeyMismatchError';
  }
}
/** The payload or its context was altered, or the payload is not in a known format. */
export class SecretDecryptionError extends Error {
  constructor() {
    super('Secret could not be decrypted');
    this.name = 'SecretDecryptionError';
  }
}

export function parseSecretKey(base64: string): SecretKey {
  const material = Buffer.from(base64, 'base64');
  // Buffer.from ignores invalid characters, so the round trip proves the text was clean base64.
  if (material.length !== KEY_BYTES || material.toString('base64') !== base64.trim())
    throw new SecretKeyFormatError();
  const id = createHash('sha256').update(material).digest('hex').slice(0, KEY_ID_HEX_LENGTH);
  return { id, material };
}

/**
 * The context (for example "storage-backend:<name>") is authenticated but not stored, so a
 * ciphertext copied to another row fails to decrypt there.
 */
function additionalData(keyId: string, context: string): Buffer {
  return Buffer.from(JSON.stringify([FORMAT_VERSION, keyId, context]));
}

export function encryptSecret({
  key,
  plaintext,
  context,
}: {
  key: SecretKey;
  plaintext: string;
  context: string;
}): EncryptedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.material, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(key.id, context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyId: key.id,
    payload: Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, ciphertext, cipher.getAuthTag()]),
  };
}

export function decryptSecret({
  key,
  encrypted,
  context,
}: {
  key: SecretKey;
  encrypted: EncryptedSecret;
  context: string;
}): string {
  if (encrypted.keyId !== key.id) throw new SecretKeyMismatchError();
  const { payload } = encrypted;
  if (payload.length < 1 + NONCE_BYTES + TAG_BYTES || payload[0] !== FORMAT_VERSION)
    throw new SecretDecryptionError();
  const nonce = payload.subarray(1, 1 + NONCE_BYTES);
  const ciphertext = payload.subarray(1 + NONCE_BYTES, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key.material, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData(key.id, context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptionError();
  }
}
