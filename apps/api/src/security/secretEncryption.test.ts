import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  SecretDecryptionError,
  SecretKeyFormatError,
  SecretKeyMismatchError,
} from './secretEncryption.js';

const key = parseSecretKey(randomBytes(32).toString('base64'));
const context = 'storage-backend:archive';

describe('secretEncryption', () => {
  it('暗号化した値は同じ鍵と文脈で元に戻り、保存形式に平文を含まない', () => {
    const encrypted = encryptSecret({ key, plaintext: 'example-secret-value', context });
    expect(encrypted.keyId).toBe(key.id);
    expect(encrypted.payload.includes(Buffer.from('example-secret-value'))).toBe(false);
    expect(decryptSecret({ key, encrypted, context })).toBe('example-secret-value');
  });

  it('同じ値を2回暗号化すると毎回異なる暗号文になる', () => {
    const first = encryptSecret({ key, plaintext: 'same', context });
    const second = encryptSecret({ key, plaintext: 'same', context });
    expect(first.payload.equals(second.payload)).toBe(false);
  });

  it('暗号文を1 byteでも書き換えると復号を拒否する', () => {
    const encrypted = encryptSecret({ key, plaintext: 'example-secret-value', context });
    const tampered = Buffer.from(encrypted.payload);
    tampered[tampered.length - 20]! ^= 0x01;
    expect(() =>
      decryptSecret({ key, encrypted: { ...encrypted, payload: tampered }, context }),
    ).toThrow(SecretDecryptionError);
  });

  it('別の行（文脈）へ写した暗号文は復号できない', () => {
    const encrypted = encryptSecret({ key, plaintext: 'example-secret-value', context });
    expect(() => decryptSecret({ key, encrypted, context: 'storage-backend:other' })).toThrow(
      SecretDecryptionError,
    );
  });

  it('別の鍵では復号せず、鍵の不一致として報告する', () => {
    const encrypted = encryptSecret({ key, plaintext: 'example-secret-value', context });
    const otherKey = parseSecretKey(randomBytes(32).toString('base64'));
    expect(otherKey.id).not.toBe(key.id);
    expect(() => decryptSecret({ key: otherKey, encrypted, context })).toThrow(
      SecretKeyMismatchError,
    );
    // Even with a forged key id, GCM authentication rejects the wrong key material.
    expect(() =>
      decryptSecret({ key: otherKey, encrypted: { ...encrypted, keyId: otherKey.id }, context }),
    ).toThrow(SecretDecryptionError);
  });

  it('32 byteのbase64以外の鍵は受け付けない', () => {
    expect(() => parseSecretKey(randomBytes(16).toString('base64'))).toThrow(SecretKeyFormatError);
    expect(() => parseSecretKey('not base64 at all!')).toThrow(SecretKeyFormatError);
  });
});
