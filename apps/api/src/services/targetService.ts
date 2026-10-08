import type { ComputeTarget } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { ApiConfig } from '../config.js';
import { first, rows, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { requireGlobalAdmin, requireScope } from './accessService.js';

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

  async create(principal: Principal, input: Omit<ComputeTarget, 'id'>): Promise<ComputeTarget> {
    requireGlobalAdmin(principal);
    if (input.executor === 'local' && !this.config.allowLocalExecutor)
      throw new DomainError(
        422,
        'Local executorにはdevelopment modeでの明示許可が必要です',
        'local_executor_disabled',
      );
    if (input.executor === 'ssh' && (!input.sshKeyPath || !input.knownHostsPath))
      throw new DomainError(
        422,
        'SSH targetには鍵とknown_hostsのパスが必要です',
        'ssh_config_required',
      );
    return (await first<ComputeTarget>(
      this.database,
      `INSERT INTO compute_targets(name,host,port,username,ssh_key_path,known_hosts_path,work_directory,python_executable,gpu_ids,max_concurrent_jobs,enabled,executor,runtime_kinds)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
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
      ],
    ))!;
  }
}
