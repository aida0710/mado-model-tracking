import { isDeepStrictEqual } from 'node:util';
import type { ComputeTarget, ExecutionRuntime, ExecutionRuntimeKind, JsonValue } from '@mmt/contracts';
import { DomainError } from './errors.js';

// A site's runner converts a docker image to a SIF itself (apptainer pull), so docker Code
// also runs on a site that has only Apptainer or Singularity.
const SIF_RUNTIME_KINDS: readonly ExecutionRuntimeKind[] = ['singularity', 'apptainer'];

export function targetRunsRuntime(
  target: Pick<ComputeTarget, 'executor' | 'runtimeKinds'>,
  kind: ExecutionRuntimeKind,
): boolean {
  if (target.runtimeKinds.includes(kind)) return true;
  return (
    target.executor === 'site' &&
    kind === 'docker' &&
    target.runtimeKinds.some((available) => SIF_RUNTIME_KINDS.includes(available))
  );
}

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
  if (!targetRunsRuntime(target, execution.runtime.kind))
    throw new DomainError(422, 'Targetがruntimeに対応していません', 'incompatible_runtime');
  if (target.executor === 'site') {
    // The site's scheduler or runner picks the GPUs; a Job asks only for how many (gpuCount).
    if (execution.gpuIds.length)
      throw new DomainError(
        422,
        'siteではGPU IDを指定できません（gpuCountで数を指定します）',
        'site_gpu_ids',
      );
    return;
  }
  if (target.executor === 'local' && !execution.allowLocalExecutor)
    throw new DomainError(422, 'Local executorは無効です', 'local_executor_disabled');
  if (execution.gpuIds.some((gpu) => !target.gpuIds.includes(gpu)))
    throw new DomainError(422, 'Targetに存在しないGPUが指定されています', 'unknown_gpu');
}
