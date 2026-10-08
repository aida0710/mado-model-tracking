import { isDeepStrictEqual } from 'node:util';
import type { ComputeTarget, ExecutionRuntime, JsonValue } from '@mmt/contracts';
import { DomainError } from './errors.js';

export function validatePinnedRuntime(
  runtime: ExecutionRuntime,
  snapshot: JsonValue | undefined,
): void {
  if (!isDeepStrictEqual(runtime, snapshot))
    throw new DomainError(422, 'Runの固定runtimeがCodeVersionと一致しません', 'runtime_mismatch');
}

export function validateTargetCompatibility(
  target: ComputeTarget,
  execution: {
    runtime: ExecutionRuntime;
    gpuIds: string[];
    allowLocalExecutor: boolean;
  },
): void {
  if (!target.runtimeKinds.includes(execution.runtime.kind))
    throw new DomainError(422, 'Targetがruntimeに対応していません', 'incompatible_runtime');
  if (target.executor === 'local' && !execution.allowLocalExecutor)
    throw new DomainError(422, 'Local executorは無効です', 'local_executor_disabled');
  if (execution.gpuIds.some((gpu) => !target.gpuIds.includes(gpu)))
    throw new DomainError(422, 'Targetに存在しないGPUが指定されています', 'unknown_gpu');
}
