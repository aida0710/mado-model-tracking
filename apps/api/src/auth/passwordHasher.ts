import argon2 from 'argon2';

// Lengths are UTF-8 bytes: one Japanese character is 3 bytes, and Argon2 limits bytes.
export const PASSWORD_MIN_BYTES = 12;
// Bounds the work an attacker can force into one hash computation.
export const PASSWORD_MAX_BYTES = 1024;

// Local accounts depend only on this interface so the algorithm (for example scrypt) can be swapped.
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  // Returns false for malformed or foreign hashes instead of throwing.
  verify(passwordHash: string, password: string): Promise<boolean>;
  needsRehash(passwordHash: string): boolean;
}

export function isAcceptablePasswordLength(password: string): boolean {
  const bytes = Buffer.byteLength(password, 'utf8');
  return bytes >= PASSWORD_MIN_BYTES && bytes <= PASSWORD_MAX_BYTES;
}

// OWASP Password Storage Cheat Sheet minimum for Argon2id. Encoded hashes carry their
// parameters and salt, so raising these values later still verifies older hashes.
const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const argon2idPasswordHasher: PasswordHasher = {
  async hash(password) {
    if (!isAcceptablePasswordLength(password))
      throw new Error(`Password must be ${PASSWORD_MIN_BYTES}-${PASSWORD_MAX_BYTES} bytes`);
    return argon2.hash(password, ARGON2ID_OPTIONS);
  },
  async verify(passwordHash, password) {
    if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return false;
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  },
  needsRehash(passwordHash) {
    try {
      return argon2.needsRehash(passwordHash, ARGON2ID_OPTIONS);
    } catch {
      return true;
    }
  },
};
