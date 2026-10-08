import { DomainError } from './errors.js';

// Automation and the server record provenance under these prefixes; automation and evaluation
// trust them, so user input on any route must not set or remove them. mlflow.* stays writable
// because MLflow clients set system tags such as mlflow.runName themselves.
export const RESERVED_RUN_TAG_PREFIXES = ['automation.', 'mmt.'] as const;

export function findReservedRunTag(keys: Iterable<string>): string | undefined {
  for (const key of keys)
    if (RESERVED_RUN_TAG_PREFIXES.some((prefix) => key.startsWith(prefix))) return key;
  return undefined;
}

export function reservedRunTagMessage(key: string): string {
  return `${key}はサーバーが管理する予約tagのため変更できません`;
}

export function assertNoReservedRunTags(tags: Record<string, string>): void {
  const reserved = findReservedRunTag(Object.keys(tags));
  if (reserved !== undefined)
    throw new DomainError(422, reservedRunTagMessage(reserved), 'reserved_tag');
}
