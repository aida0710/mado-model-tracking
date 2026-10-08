import { DomainError } from './errors.js';

export function automationFailureMessage(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  const databaseCode = (error as { code?: unknown } | null)?.code;
  if (databaseCode === '23503' || databaseCode === '23514')
    return 'invalid_reference: 自動実行の参照または保存制約に違反しました';
  if (databaseCode === '23505') return 'already_exists: 自動実行の登録が重複しました';
  // Provider and SQL exception details can contain credentials or input parameters.
  return 'automation_failed: 自動実行のRunまたはJobを登録できませんでした';
}
