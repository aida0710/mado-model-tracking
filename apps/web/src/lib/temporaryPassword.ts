// The API's passwordHasher accepts 12-1024 UTF-8 bytes; checking the minimum here gives an
// immediate message instead of a 422 after submitting.
const PASSWORD_MIN_BYTES = 12;
// 18 random bytes give 24 base64url characters, the same as the API's reset password.
const GENERATED_PASSWORD_BYTES = 18;

/** A random initial password the administrator can hand over once. */
export function generateTemporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_PASSWORD_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function isLongEnoughPassword(password: string): boolean {
  return new TextEncoder().encode(password).length >= PASSWORD_MIN_BYTES;
}
