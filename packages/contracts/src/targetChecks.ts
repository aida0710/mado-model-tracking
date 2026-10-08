import type { ExecutionRuntimeKind } from './executionRuntime.js';
import type { ComputeTarget } from './index.js';

// A connection check that a worker runs against a ComputeTarget over its own SSH key.
// The API never connects to the target; it only queues the request and stores the result.
export type TargetCheckStatus = 'queued' | 'claimed' | 'finished' | 'failed';

// Why a check ended without a result from the worker.
// no_worker: no worker in charge of the target claimed it in time.
// claim_timeout: the claiming worker did not report back in time.
export type TargetCheckFailureReason = 'no_worker' | 'claim_timeout';

export type TargetCheckItemName =
  | 'connection'
  | 'python'
  | 'venv'
  | 'pip'
  | 'git'
  | 'docker'
  | 'apptainer'
  | 'singularity'
  | 'gpu'
  | 'work_directory'
  | 'api';

// ng is a problem for Jobs that need the item; unavailable means the item is optional
// (for example docker on a Python-only target) and was not found.
export type TargetCheckItemStatus = 'ok' | 'ng' | 'unavailable' | 'skipped';

// Machine-readable reason for ng/unavailable/skipped; the Web shows a fix hint per code.
export type TargetCheckItemCode =
  | 'ssh_failed'
  | 'ssh_configuration'
  | 'probe_failed'
  | 'python_missing'
  | 'python_too_old'
  | 'venv_missing'
  | 'pip_missing'
  | 'git_missing'
  | 'docker_missing'
  | 'docker_socket_denied'
  | 'docker_daemon_unreachable'
  | 'container_cli_missing'
  | 'container_flags_missing'
  | 'nvidia_smi_missing'
  | 'nvidia_smi_failed'
  | 'work_directory_not_writable'
  | 'api_unreachable'
  | 'connection_failed';

export interface TargetCheckItem {
  name: TargetCheckItemName;
  status: TargetCheckItemStatus;
  code: TargetCheckItemCode | null;
  // Short fact such as a version string; never a key path, token or command output dump.
  detail: string | null;
}

// One row of `nvidia-smi --query-gpu=index,uuid,name,memory.total`.
export interface TargetCheckGpu {
  index: string;
  uuid: string;
  name: string;
  memoryTotalMiB: number;
}

export interface TargetCheckResult {
  version: 1;
  items: TargetCheckItem[];
  // null when nvidia-smi is unavailable; GPU values are only what nvidia-smi reported.
  gpus: TargetCheckGpu[] | null;
  // Runtime kinds whose checks passed; offered as candidates, never applied automatically.
  runtimeKinds: ExecutionRuntimeKind[];
  workDirectoryFreeBytes: number | null;
}

export interface TargetCheck {
  id: string;
  targetId: string;
  requestedBy: string;
  status: TargetCheckStatus;
  workerId: string | null;
  result: TargetCheckResult | null;
  failureReason: TargetCheckFailureReason | null;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}

export interface WorkerTargetCheckClaim {
  workerId: string;
  targetIds: string[];
}

// The lease is returned only to the claiming worker and must accompany the completion.
export interface WorkerTargetCheck {
  check: TargetCheck;
  leaseId: string;
  target: ComputeTarget;
}

export interface WorkerTargetCheckComplete {
  leaseId: string;
  // failed: the worker could not run the probe (its result explains why).
  status: 'finished' | 'failed';
  result: TargetCheckResult;
}
