import { isDeepStrictEqual } from 'node:util';
import type { ComputeTarget } from '@mmt/contracts';
import { DomainError } from './errors.js';

export function validateTargetConfiguration(
  target: Omit<ComputeTarget, 'id'>,
  allowLocalExecutor: boolean,
): void {
  if (target.executor === 'local' && !allowLocalExecutor)
    throw new DomainError(
      422,
      'Local executorにはdevelopment modeでの明示許可が必要です',
      'local_executor_disabled',
    );
  if (target.executor === 'ssh' && (!target.sshKeyPath || !target.knownHostsPath))
    throw new DomainError(
      422,
      'SSH targetには鍵とknown_hostsのパスが必要です',
      'ssh_config_required',
    );
}

// These fields affect queued launches and reattachment of existing remote processes.
const executionFields = [
  'host',
  'port',
  'username',
  'sshKeyPath',
  'knownHostsPath',
  'workDirectory',
  'pythonExecutable',
  'runtimeKinds',
  'gpuIds',
  'executor',
] as const;

export function hasTargetExecutionChanges(previous: ComputeTarget, next: ComputeTarget): boolean {
  return executionFields.some((field) => !isDeepStrictEqual(previous[field], next[field]));
}
