import { isDeepStrictEqual } from 'node:util';
import type { ComputeTarget } from '@mmt/contracts';
import { DomainError } from './errors.js';

// What tracking stores for a site beyond its name: no address, account, keys or GPU IDs.
function hasSiteOnlyDescription(target: Omit<ComputeTarget, 'id' | 'ownerUserId'>): boolean {
  const connection = [
    target.host,
    target.username,
    target.sshKeyPath,
    target.knownHostsPath,
    target.workDirectory,
    target.pythonExecutable,
  ];
  return (
    connection.every((value) => value === '') &&
    target.gpuIds.length === 0 &&
    !target.runtimeKinds.includes('python') &&
    target.datasetTransfer === 'direct'
  );
}

export function validateTargetConfiguration(
  target: Omit<ComputeTarget, 'id' | 'ownerUserId'>,
  allowLocalExecutor: boolean,
): void {
  if (target.executor === 'site') {
    if (!hasSiteOnlyDescription(target))
      throw new DomainError(
        422,
        'siteには接続設定・GPU ID・python runtimeを登録できません（runtimeはコンテナ、datasetTransferはdirect）',
        'site_target_settings',
      );
    return;
  }
  if (target.submissionMode !== 'automatic' || target.supportsArray || target.queueTimeoutSeconds !== null)
    throw new DomainError(
      422,
      '手動投入・array・待ち行列の上限時間はsiteだけの設定です',
      'site_only_setting',
    );
  if (!target.host || !target.username || !target.workDirectory || !target.pythonExecutable)
    throw new DomainError(
      422,
      'host・username・workDirectory・pythonExecutableが必要です',
      'target_connection_required',
    );
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

// These fields affect queued launches and reattachment of existing remote processes. The dataset
// settings decide where a claimed Job's inputs come from and which cache entries may be deleted.
// A site's submission mode, arrays and CPU decide how its queued Jobs are submitted and built.
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
  'datasetCacheMaxBytes',
  'datasetTransfer',
  'submissionMode',
  'supportsArray',
  'cpuArch',
] as const;

export function hasTargetExecutionChanges(previous: ComputeTarget, next: ComputeTarget): boolean {
  return executionFields.some((field) => !isDeepStrictEqual(previous[field], next[field]));
}
