// SHA-256 of a file slice for the optional X-Part-SHA256 check.

/** Web Crypto exists only in secure contexts; on a plain http LAN origin the check is skipped. */
export function canDigest(): boolean {
  return typeof crypto !== 'undefined' && crypto.subtle !== undefined;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
