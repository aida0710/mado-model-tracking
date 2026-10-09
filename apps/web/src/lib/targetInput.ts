import {
  CPU_ARCHES,
  SITE_SUBMISSION_MODES,
  type ComputeTarget,
  type CpuArch,
  type ExecutionRuntimeKind,
  type SiteSubmissionMode,
} from '@mmt/contracts';
import type { CreateTarget } from '../api/inputs';
import type { FormValues } from '../types/form';
import { getFieldValue, getSelectedValues, parsePositiveInteger, splitLines } from './formValues';
import { parseRuntimeKinds } from './runtimeValidation';
import { formatClockDuration } from './clockDuration';
import { parseQueueTimeout } from './siteExecutionInput';
import { text } from '../i18n/catalog';

// The dialog edits the dataset cache bound in GiB; the API stores bytes.
export const BYTES_PER_GIB = 1024 ** 3;
// Sites run containers only (the API refuses python with site_target_settings).
export const SITE_RUNTIME_KINDS: readonly ExecutionRuntimeKind[] = [
  'docker',
  'singularity',
  'apptainer',
];
// Supercomputers commonly offer Apptainer; a new site starts with it selected.
export const DEFAULT_SITE_RUNTIME_KINDS: ExecutionRuntimeKind[] = ['apptainer'];
const SSH_DEFAULT_PORT = 22;
/**
 * What the API stores for a site: its launcher and job shell hold the connection, keys and
 * scheduler settings, and its runner downloads inputs itself with the Job token.
 */
const SITE_STORED_CONNECTION = {
  host: '',
  port: SSH_DEFAULT_PORT,
  username: '',
  sshKeyPath: '',
  knownHostsPath: '',
  workDirectory: '',
  pythonExecutable: '',
  datasetTransfer: 'direct',
} as const satisfies Partial<CreateTarget>;
// Settings only a site may change from these values (the API answers site_only_setting).
const NON_SITE_SETTINGS = {
  submissionMode: 'automatic',
  supportsArray: false,
  queueTimeoutSeconds: null,
} as const satisfies Partial<CreateTarget>;

export function datasetCacheGiB(target: Pick<ComputeTarget, 'datasetCacheMaxBytes'>): string {
  return String(Math.max(1, Math.round(target.datasetCacheMaxBytes / BYTES_PER_GIB)));
}

function parseSiteRuntimeKinds(values: string[]): ExecutionRuntimeKind[] {
  if (!values.length || values.some((value) => !SITE_RUNTIME_KINDS.includes(value as ExecutionRuntimeKind)))
    throw new Error(text.siteRuntimeKindsError);
  return [...new Set(values)] as ExecutionRuntimeKind[];
}

function parseChoice<T extends string>(value: string, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error(text.required);
  return value as T;
}

/**
 * The target as the API takes it. `previous` is the target being edited: a cache bound set
 * through the API in bytes is kept unless the GiB field was changed.
 */
export function buildTargetInput(values: FormValues, previous?: ComputeTarget): CreateTarget {
  const executor = parseChoice(getFieldValue(values, 'executor'), ['ssh', 'local', 'site'] as const);
  const cacheGiB = getFieldValue(values, 'datasetCacheMaxGiB');
  const common = {
    name: getFieldValue(values, 'name'),
    executor,
    maxConcurrentJobs: parsePositiveInteger(getFieldValue(values, 'maxConcurrentJobs')),
    enabled: getFieldValue(values, 'enabled') === 'true',
    datasetCacheMaxBytes:
      previous && cacheGiB === datasetCacheGiB(previous)
        ? previous.datasetCacheMaxBytes
        : parsePositiveInteger(cacheGiB) * BYTES_PER_GIB,
    cpuArch: parseChoice<CpuArch>(getFieldValue(values, 'cpuArch'), CPU_ARCHES),
  };
  if (executor === 'site')
    return {
      ...common,
      ...SITE_STORED_CONNECTION,
      gpuIds: [],
      runtimeKinds: parseSiteRuntimeKinds(getSelectedValues(values, 'siteRuntimeKinds')),
      submissionMode: parseChoice<SiteSubmissionMode>(
        getFieldValue(values, 'submissionMode'),
        SITE_SUBMISSION_MODES,
      ),
      supportsArray: getFieldValue(values, 'supportsArray') === 'true',
      queueTimeoutSeconds: parseQueueTimeout(getFieldValue(values, 'queueTimeout')),
    };
  return {
    ...common,
    ...NON_SITE_SETTINGS,
    host: getFieldValue(values, 'host'),
    port: parsePositiveInteger(getFieldValue(values, 'port')),
    username: getFieldValue(values, 'username'),
    sshKeyPath: getFieldValue(values, 'sshKeyPath'),
    knownHostsPath: getFieldValue(values, 'knownHostsPath'),
    workDirectory: getFieldValue(values, 'workDirectory'),
    pythonExecutable: getFieldValue(values, 'pythonExecutable'),
    runtimeKinds: parseRuntimeKinds(getSelectedValues(values, 'runtimeKinds')),
    gpuIds: splitLines(getFieldValue(values, 'gpuIds')),
    datasetTransfer: getFieldValue(values, 'datasetTransfer') as CreateTarget['datasetTransfer'],
  };
}

/**
 * The form values of a saved target. The runtime selections of both kinds are filled, so switching
 * the executor keeps the container runtimes the target already has.
 */
export function targetFormValues(target: ComputeTarget): FormValues {
  const containerKinds = target.runtimeKinds.filter((kind) => SITE_RUNTIME_KINDS.includes(kind));
  return {
    name: target.name,
    executor: target.executor,
    host: target.host,
    port: String(target.port),
    username: target.username,
    sshKeyPath: target.sshKeyPath,
    knownHostsPath: target.knownHostsPath,
    workDirectory: target.workDirectory,
    pythonExecutable: target.pythonExecutable,
    runtimeKinds: target.runtimeKinds,
    siteRuntimeKinds: containerKinds.length ? containerKinds : DEFAULT_SITE_RUNTIME_KINDS,
    gpuIds: target.gpuIds.join('\n'),
    maxConcurrentJobs: String(target.maxConcurrentJobs),
    datasetTransfer: target.datasetTransfer,
    datasetCacheMaxGiB: datasetCacheGiB(target),
    enabled: String(target.enabled),
    submissionMode: target.submissionMode,
    cpuArch: target.cpuArch,
    supportsArray: String(target.supportsArray),
    queueTimeout: formatClockDuration(target.queueTimeoutSeconds),
  };
}
