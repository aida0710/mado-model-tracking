import {
  CPU_ARCHES,
  MAX_SITE_CANCEL_COMMAND_LENGTH,
  SITE_ACCOUNT_MODES,
  SITE_CLAIM_MAX_SUBMISSIONS,
  SITE_GPU_ASSIGNMENTS,
  type ComputeTargetDetails,
  type Launcher,
  type Project,
} from '@mmt/contracts';
import type { FormField, FormValues } from '../types/form';
import { FormFields } from './FormFields';
import { JobShellEditor } from './JobShellEditor';
import { getFieldValue } from '../lib/formValues';
import { SITE_RUNTIME_KINDS, TARGET_OWNERSHIPS } from '../lib/targetInput';
import { JOB_SHELL_TEMPLATES } from '../lib/jobShellTemplates';
import { launcherOptions, shareableProjectOptions } from '../lib/siteComputerDisplay';
import { EXECUTION_RUNTIME_KINDS } from '../lib/runtimeValidation';
import { runtimeLabels } from '../i18n/runtime';
import { cpuArchLabels } from '../i18n/compute';
import {
  jobShellTemplateLabels,
  siteAccountModeLabels,
  siteGpuAssignmentLabels,
  targetOwnershipLabels,
} from '../i18n/siteComputers';
import { text } from '../i18n/catalog';

const MAX_PORT = 65535;
const MAX_CONCURRENT_JOBS = 128;

/**
 * The target dialog's fields. ssh and local targets keep their connection here; a site also takes
 * its global settings (submission, connection, accounts, how it runs) and, when it is added, whose
 * it is and its first job shell. A researcher adds only a site of their own.
 */
export function TargetFields({
  values,
  onChange,
  target,
  canAddGlobal,
  allowLocal,
  launchers,
  projects,
}: {
  values: FormValues;
  onChange: (values: FormValues) => void;
  /** The target being edited; a new one when absent. */
  target?: ComputeTargetDetails;
  /** A global administrator, who adds global targets of every executor. */
  canAddGlobal: boolean;
  allowLocal: boolean;
  launchers: Launcher[];
  projects: Project[];
}) {
  const isNew = !target;
  const isSite = getFieldValue(values, 'executor') === 'site';
  const isSsh = getFieldValue(values, 'executor') === 'ssh';
  const isOwned = target
    ? target.ownerUserId !== null
    : getFieldValue(values, 'ownership') === 'personal';
  const isAutomatic = getFieldValue(values, 'submissionMode') === 'automatic';
  const isSharedAccount = getFieldValue(values, 'accountMode') === 'shared';
  const launcherId = getFieldValue(values, 'launcherId');
  const projectOptions = shareableProjectOptions(projects, target?.projectIds ?? []);
  // Owned computers are sites only; only global ones may change their executor.
  const canChooseExecutor = canAddGlobal && (!target || target.ownerUserId === null);
  const targetFields: FormField[] = [
    { name: 'name', label: text.name, required: true },
    {
      name: 'executor',
      label: text.executor,
      type: 'select',
      visible: () => canChooseExecutor,
      options: [
        { value: 'ssh', label: text.ssh },
        ...(allowLocal ? [{ value: 'local', label: text.local }] : []),
        { value: 'site', label: text.siteExecutor },
      ],
    },
    {
      name: 'ownership',
      label: text.targetOwnership,
      type: 'select',
      visible: () => isSite && isNew && canAddGlobal,
      options: TARGET_OWNERSHIPS.map((ownership) => ({
        value: ownership,
        label: targetOwnershipLabels[ownership],
      })),
    },
    {
      name: 'projectIds',
      label: text.targetProjects,
      type: 'multiselect',
      visible: () => isSite && isOwned && projectOptions.length > 0,
      options: projectOptions,
    },
  ];
  const descriptionFields: FormField[] = [
    {
      name: 'jobShellTemplate',
      label: text.jobShellTemplate,
      type: 'select',
      visible: () => isSite && isNew,
      options: [
        { value: '', label: text.jobShellTemplateNone },
        ...JOB_SHELL_TEMPLATES.map((template) => ({
          value: template.key,
          label: jobShellTemplateLabels[template.key],
        })),
      ],
    },
    {
      name: 'submissionMode',
      label: text.submissionMode,
      type: 'select',
      visible: () => isSite,
      options: [
        { value: 'automatic', label: text.submissionModeAutomatic },
        { value: 'manual', label: text.submissionModeManual },
      ],
    },
    { name: 'host', label: text.host, required: true, visible: () => !isSite },
    {
      name: 'port',
      label: text.port,
      type: 'number',
      required: true,
      min: 1,
      max: MAX_PORT,
      visible: () => !isSite,
    },
    { name: 'username', label: text.sshUsername, required: true, visible: () => !isSite },
    { name: 'sshKeyPath', label: text.sshKeyPath, required: true, visible: () => isSsh },
    { name: 'knownHostsPath', label: text.knownHostsPath, required: true, visible: () => isSsh },
    { name: 'workDirectory', label: text.workDirectory, required: true, visible: () => !isSite },
    {
      name: 'pythonExecutable',
      label: text.pythonExecutable,
      required: true,
      visible: () => !isSite,
    },
    {
      name: 'cpuArch',
      label: text.cpuArch,
      type: 'select',
      options: CPU_ARCHES.map((arch) => ({ value: arch, label: cpuArchLabels[arch] })),
    },
    {
      name: 'runtimeKinds',
      label: text.runtimeKinds,
      type: 'multiselect',
      required: true,
      visible: () => !isSite,
      options: EXECUTION_RUNTIME_KINDS.map((kind) => ({ value: kind, label: runtimeLabels[kind] })),
    },
    {
      name: 'siteRuntimeKinds',
      label: text.siteRuntimeKinds,
      type: 'multiselect',
      required: true,
      visible: () => isSite,
      options: SITE_RUNTIME_KINDS.map((kind) => ({ value: kind, label: runtimeLabels[kind] })),
    },
    { name: 'gpuIds', label: text.gpuIdsPerLine, type: 'textarea', visible: () => !isSite },
    { name: 'supportsArray', label: text.supportsArray, type: 'checkbox', visible: () => isSite },
    {
      name: 'queueTimeout',
      label: text.queueTimeout,
      placeholder: text.queueTimeoutPlaceholder,
      visible: () => isSite,
    },
    {
      name: 'maxConcurrentJobs',
      label: text.maxConcurrentJobs,
      type: 'number',
      required: true,
      min: 1,
      max: MAX_CONCURRENT_JOBS,
    },
    {
      name: 'datasetTransfer',
      label: text.datasetTransfer,
      type: 'select',
      visible: () => !isSite,
      options: [
        { value: 'relay', label: text.datasetTransferRelay },
        { value: 'direct', label: text.datasetTransferDirect },
      ],
    },
    {
      name: 'datasetCacheMaxGiB',
      label: text.datasetCacheMaxGiB,
      type: 'number',
      required: true,
      min: 1,
    },
    { name: 'enabled', label: text.enabled, type: 'checkbox' },
  ];
  const connectionFields: FormField[] = [
    {
      name: 'launcherId',
      label: text.launcherId,
      type: 'select',
      required: true,
      options: [{ value: '', label: text.launcherUnset }, ...launcherOptions(launchers, launcherId)],
    },
    { name: 'siteHost', label: text.siteHost, required: true },
    { name: 'sitePort', label: text.sitePort, type: 'number', required: true, min: 1, max: MAX_PORT },
    { name: 'siteJumpHosts', label: text.siteJumpHosts, type: 'textarea' },
    { name: 'siteKnownHosts', label: text.siteKnownHosts, type: 'textarea', required: true },
    {
      name: 'accountMode',
      label: text.accountMode,
      type: 'select',
      options: SITE_ACCOUNT_MODES.map((mode) => ({
        value: mode,
        label: siteAccountModeLabels[mode],
      })),
    },
    {
      name: 'sharedAccount',
      label: text.sharedAccount,
      required: true,
      visible: () => isSharedAccount,
    },
  ];
  const executionFields: FormField[] = [
    {
      name: 'siteWorkDirectory',
      label: text.siteWorkDirectory,
      // A shared account has no personal settings, so the site's directory is the only one.
      required: isAutomatic && isSharedAccount,
    },
    { name: 'runnerPython', label: text.runnerPython, required: true },
    {
      name: 'runnerApiUrl',
      label: text.runnerApiUrl,
      type: 'url',
      placeholder: text.runnerApiUrlPlaceholder,
    },
    { name: 'cancelCommand', label: text.cancelCommand, maxLength: MAX_SITE_CANCEL_COMMAND_LENGTH },
    {
      name: 'gpuAssignment',
      label: text.gpuAssignment,
      type: 'select',
      options: SITE_GPU_ASSIGNMENTS.map((assignment) => ({
        value: assignment,
        label: siteGpuAssignmentLabels[assignment],
      })),
    },
    {
      name: 'leaseGpuIds',
      label: text.leaseGpuIds,
      type: 'textarea',
      visible: (current) => getFieldValue(current, 'gpuAssignment') === 'lease',
    },
    { name: 'siteVariables', label: text.siteVariables, type: 'textarea' },
    {
      name: 'maxActiveSubmissions',
      label: text.maxActiveSubmissions,
      type: 'number',
      required: true,
      min: 1,
      max: SITE_CLAIM_MAX_SUBMISSIONS,
    },
  ];
  // These sit in a closed <details>, where the browser cannot point at an invalid field, so their
  // ranges are checked when the form is saved (buildSiteSettingsInput) instead.
  const advancedFields: FormField[] = [
    { name: 'cancelGraceSeconds', label: text.cancelGraceSeconds, type: 'number' },
    { name: 'maxOutputFiles', label: text.maxOutputFiles, type: 'number' },
  ];
  return (
    <>
      {isNew && !canAddGlobal && <p className="notice">{text.personalTargetNotice}</p>}
      <FormFields fields={targetFields} values={values} onChange={onChange} />
      {isSite && isOwned && (
        <p className="muted">
          {projectOptions.length ? text.targetProjectsHint : text.noShareableProjects}
        </p>
      )}
      {isSite && isNew && <p className="muted">{text.jobShellTemplateHint}</p>}
      <FormFields fields={descriptionFields} values={values} onChange={onChange} />
      {isSite && (
        <>
          {isAutomatic && (
            <>
              <h3 className="form-section-heading">{text.siteSubmissionSection}</h3>
              {!launchers.some((launcher) => launcher.revokedAt === null) && (
                <p className="notice">{text.noLaunchersNotice}</p>
              )}
              <FormFields fields={connectionFields} values={values} onChange={onChange} />
              <p className="muted">{text.siteKnownHostsHint}</p>
            </>
          )}
          <h3 className="form-section-heading">{text.siteExecutionSection}</h3>
          <FormFields fields={executionFields} values={values} onChange={onChange} />
          <p className="muted">{text.siteExecutionHint}</p>
          <details className="form-details">
            <summary>{text.siteAdvancedSettings}</summary>
            <FormFields fields={advancedFields} values={values} onChange={onChange} />
          </details>
          {isNew && (
            <>
              <h3 className="form-section-heading">{text.jobShellSection}</h3>
              <JobShellEditor
                value={getFieldValue(values, 'jobShell')}
                required
                onChange={(content) => onChange({ ...values, jobShell: content })}
              />
            </>
          )}
          <p className="notice">{text.siteTargetNotice}</p>
        </>
      )}
    </>
  );
}
