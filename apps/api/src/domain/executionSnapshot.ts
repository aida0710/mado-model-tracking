import { isDeepStrictEqual } from 'node:util';
import type { CodeVersion, ExecutionMode, ExecutionSnapshot, Run } from '@mmt/contracts';
import { DomainError } from './errors.js';

export function createExecutionSnapshot(code: CodeVersion, mode: ExecutionMode): ExecutionSnapshot {
  const entrypoint = mode === 'test' ? (code.testEntrypoint ?? []) : code.entrypoint;
  if (!entrypoint.length)
    throw new DomainError(
      422,
      'CodeVersionにテストコマンドが登録されていません',
      'test_entrypoint_required',
    );
  return {
    codeVersionId: code.id,
    version: code.version,
    mode,
    source: code.source,
    runtime: code.runtime,
    entrypoint,
    requirements: code.requirements,
    environment: code.environment,
  };
}

export function validateExecutionSnapshot(code: CodeVersion, run: Run): void {
  if (
    !isDeepStrictEqual(
      createExecutionSnapshot(code, run.executionMode ?? 'run'),
      run.executionSnapshot,
    )
  )
    throw new DomainError(
      422,
      'Runの固定実行内容がCodeVersionと一致しません',
      'execution_snapshot_mismatch',
    );
}
