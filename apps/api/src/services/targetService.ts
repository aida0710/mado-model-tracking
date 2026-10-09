import type { ComputeTarget } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { ApiConfig } from '../config.js';
import { first, rows, transaction, type Database } from '../db/database.js';
import { conflict, notFound } from '../domain/errors.js';
import {
  hasTargetExecutionChanges,
  validateTargetConfiguration,
} from '../domain/targetConfiguration.js';
import type { TargetCreate, TargetPatch } from '../domain/validation.js';
import { requireGlobalAdmin, requireScope } from './accessService.js';
import { submissionCountSql } from './siteJobEnding.js';

export class TargetService {
  constructor(
    private readonly database: Database,
    private readonly config: ApiConfig,
  ) {}

  async list(principal: Principal): Promise<ComputeTarget[]> {
    requireScope(principal, 'read');
    const targets = await rows<ComputeTarget>(
      this.database,
      'SELECT * FROM compute_targets ORDER BY name',
    );
    if (principal.user.isAdmin && principal.method === 'session') return targets;
    // Host and SSH file paths are infrastructure details; workers receive full targets only after claim.
    return targets.map((target) => ({
      ...target,
      host: '',
      username: '',
      sshKeyPath: '',
      knownHostsPath: '',
      workDirectory: '',
      pythonExecutable: '',
    }));
  }

  async create(principal: Principal, request: TargetCreate): Promise<ComputeTarget> {
    requireGlobalAdmin(principal);
    // A site's runner downloads inputs itself with the Job token; ssh/local relay through the worker.
    const input = {
      ...request,
      datasetTransfer: request.datasetTransfer ?? (request.executor === 'site' ? 'direct' : 'relay'),
    };
    validateTargetConfiguration(input, this.config.allowLocalExecutor);
    return (await first<ComputeTarget>(
      this.database,
      `INSERT INTO compute_targets(name,host,port,username,ssh_key_path,known_hosts_path,work_directory,python_executable,gpu_ids,max_concurrent_jobs,enabled,executor,runtime_kinds,dataset_cache_max_bytes,dataset_transfer,
        submission_mode,cpu_arch,supports_array,queue_timeout_seconds)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        input.name,
        input.host,
        input.port,
        input.username,
        input.sshKeyPath,
        input.knownHostsPath,
        input.workDirectory,
        input.pythonExecutable,
        input.gpuIds,
        input.maxConcurrentJobs,
        input.enabled,
        input.executor,
        input.runtimeKinds,
        input.datasetCacheMaxBytes,
        input.datasetTransfer,
        input.submissionMode,
        input.cpuArch,
        input.supportsArray,
        input.queueTimeoutSeconds,
      ],
    ))!;
  }

  async patch(principal: Principal, targetId: string, input: TargetPatch): Promise<ComputeTarget> {
    requireGlobalAdmin(principal);
    return transaction(this.database, async (connection) => {
      const target = await first<ComputeTarget>(
        connection,
        'SELECT * FROM compute_targets WHERE id=$1 FOR UPDATE',
        [targetId],
      );
      if (!target) notFound('ComputeTarget');
      const updated = { ...target, ...input };
      validateTargetConfiguration(updated, this.config.allowLocalExecutor);
      const occupancy = (await first<{ pending: number; active: number }>(
        connection,
        `SELECT count(*)::int AS pending,
          ${submissionCountSql('$2', " FILTER(WHERE status IN ('claimed','running'))")} AS active
        FROM jobs WHERE target_id=$1 AND status IN ('queued','claimed','running')`,
        [targetId, target.supportsArray],
      ))!;
      if (occupancy.pending && hasTargetExecutionChanges(target, updated))
        conflict('未完了JobがあるComputeTargetの実行設定は変更できません');
      if (updated.maxConcurrentJobs < occupancy.active)
        conflict('同時実行数を実行中Jobの数より小さくできません');
      return (await first<ComputeTarget>(
        connection,
        `UPDATE compute_targets SET name=$2,host=$3,port=$4,username=$5,ssh_key_path=$6,known_hosts_path=$7,
        work_directory=$8,python_executable=$9,gpu_ids=$10,max_concurrent_jobs=$11,enabled=$12,executor=$13,runtime_kinds=$14,
        dataset_cache_max_bytes=$15,dataset_transfer=$16,submission_mode=$17,cpu_arch=$18,supports_array=$19,
        queue_timeout_seconds=$20
        WHERE id=$1 RETURNING *`,
        [
          targetId,
          updated.name,
          updated.host,
          updated.port,
          updated.username,
          updated.sshKeyPath,
          updated.knownHostsPath,
          updated.workDirectory,
          updated.pythonExecutable,
          updated.gpuIds,
          updated.maxConcurrentJobs,
          updated.enabled,
          updated.executor,
          updated.runtimeKinds,
          updated.datasetCacheMaxBytes,
          updated.datasetTransfer,
          updated.submissionMode,
          updated.cpuArch,
          updated.supportsArray,
          updated.queueTimeoutSeconds,
        ],
      ))!;
    });
  }
}
