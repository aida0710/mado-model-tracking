// Storage keys are application-generated IDs. The original filename belongs in metadata.
const MAX_STORAGE_KEY_LENGTH = 1024;
export function validateArtifactKey(key: string): void {
  if (
    !key ||
    key.length > MAX_STORAGE_KEY_LENGTH ||
    key.split('/').some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
  ) {
    throw new Error('Invalid Artifact storage key');
  }
}
