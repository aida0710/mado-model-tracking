import {
  COMPUTE_TARGET_VISIBILITIES,
  CPU_ARCHES,
  DEFAULT_DATASET_CACHE_MAX_BYTES,
  SITE_SUBMISSION_MODES,
  type ComputeTarget,
  type ComputeTargetDetails,
  type ComputeTargetVisibility,
  type CpuArch,
  type ExecutionRuntimeKind,
  type SiteSubmissionMode,
} from '@mmt/contracts';
import type { CreateTarget } from '../api/inputs';
import type { FormValues } from '../types/form';
import {
  getFieldValue,
  getSelectedValues,
  parseChoice,
  parsePositiveInteger,
  splitLines,
} from './formValues';
import { parseRuntimeKinds } from './runtimeValidation';
import { formatClockDuration } from './clockDuration';
import { parseQueueTimeout } from './siteExecutionInput';
import { buildSiteSettingsInput, siteSettingsFormValues } from './siteSettingsInput';
import { findJobShellTemplate, type JobShellTemplate } from './jobShellTemplates';
import { parseJobShellContent } from './jobShellContent';
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
const DEFAULT_PYTHON_EXECUTABLE = 'python3';
const DEFAULT_MAX_CONCURRENT_JOBS = 1;
/**
 * The ComputeTarget fields a site keeps empty: its settings hold the connection and accounts, and
 * its runner downloads inputs itself with the Job token.
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

// A new computer serves its owner until they open it to everyone (the API's default too).
const DEFAULT_TARGET_VISIBILITY: ComputeTargetVisibility = 'private';

/** A target's own fields with a site's global settings, as both POST and PATCH take them. */
export type TargetInput = Omit<CreateTarget, 'jobShell'>;

export function datasetCacheGiB(target: Pick<ComputeTarget, 'datasetCacheMaxBytes'>): string {
  return String(Math.max(1, Math.round(target.datasetCacheMaxBytes / BYTES_PER_GIB)));
}

function parseSiteRuntimeKinds(values: string[]): ExecutionRuntimeKind[] {
  if (!values.length || values.some((value) => !SITE_RUNTIME_KINDS.includes(value as ExecutionRuntimeKind)))
    throw new Error(text.siteRuntimeKindsError);
  return [...new Set(values)] as ExecutionRuntimeKind[];
}

/**
 * The target as the API takes it. `previous` is the target being edited: a cache bound set
 * through the API in bytes is kept unless the GiB field was changed.
 */
export function buildTargetInput(values: FormValues, previous?: ComputeTarget): TargetInput {
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
    visibility: parseChoice<ComputeTargetVisibility>(
      getFieldValue(values, 'visibility'),
      COMPUTE_TARGET_VISIBILITIES,
    ),
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
      site: buildSiteSettingsInput(values),
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

/** POST /targets: whoever adds the computer owns it; a new site also takes its first job shell. */
export function buildTargetCreate(values: FormValues): CreateTarget {
  const target = buildTargetInput(values);
  if (target.executor !== 'site') return target;
  return { ...target, jobShell: parseJobShellContent(getFieldValue(values, 'jobShell')) };
}

/** The form with a template's job shell and the settings that go with it. */
export function applyJobShellTemplate(values: FormValues, template: JobShellTemplate): FormValues {
  return {
    ...values,
    jobShell: template.content,
    cancelCommand: template.cancelCommand ?? '',
    supportsArray: String(template.supportsArray),
    gpuAssignment: template.gpuAssignment,
    siteRuntimeKinds: [...template.runtimeKinds],
  };
}

/** Choosing a job shell template fills in its content and defaults; other changes stay as typed. */
export function updateTargetValues(previous: FormValues, next: FormValues): FormValues {
  const templateKey = getFieldValue(next, 'jobShellTemplate');
  if (templateKey === getFieldValue(previous, 'jobShellTemplate')) return next;
  const template = findJobShellTemplate(templateKey);
  return template ? applyJobShellTemplate(next, template) : next;
}

/**
 * The form values of a new target, private until chosen otherwise. A researcher adds only sites; a
 * global administrator starts from an ssh target and may choose any executor.
 */
export function newTargetFormValues({ canAddSshOrLocal }: { canAddSshOrLocal: boolean }): FormValues {
  return {
    name: '',
    executor: canAddSshOrLocal ? 'ssh' : 'site',
    visibility: DEFAULT_TARGET_VISIBILITY,
    host: '',
    port: String(SSH_DEFAULT_PORT),
    username: '',
    sshKeyPath: '',
    knownHostsPath: '',
    workDirectory: '',
    pythonExecutable: DEFAULT_PYTHON_EXECUTABLE,
    runtimeKinds: ['python'],
    siteRuntimeKinds: DEFAULT_SITE_RUNTIME_KINDS,
    gpuIds: '',
    maxConcurrentJobs: String(DEFAULT_MAX_CONCURRENT_JOBS),
    datasetTransfer: 'relay',
    datasetCacheMaxGiB: String(DEFAULT_DATASET_CACHE_MAX_BYTES / BYTES_PER_GIB),
    enabled: 'true',
    submissionMode: 'automatic',
    cpuArch: 'amd64',
    supportsArray: 'false',
    queueTimeout: '',
    ...siteSettingsFormValues(null),
    jobShellTemplate: '',
    jobShell: '',
  };
}

/**
 * The form values of a saved target. The runtime selections of both kinds are filled, so switching
 * the executor keeps the container runtimes the target already has.
 */
export function targetFormValues(target: ComputeTargetDetails): FormValues {
  const containerKinds = target.runtimeKinds.filter((kind) => SITE_RUNTIME_KINDS.includes(kind));
  return {
    name: target.name,
    executor: target.executor,
    visibility: target.visibility,
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
    ...siteSettingsFormValues(target.site),
    jobShellTemplate: '',
    jobShell: '',
  };
}
