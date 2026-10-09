import {
  CPU_ARCHES,
  DEFAULT_DATASET_CACHE_MAX_BYTES,
  type ComputeTarget,
} from '@mmt/contracts';
import type { FormField, FormValues } from '../types/form';
import { executionApi } from '../api/execution';
import { authApi } from '../api/auth';
import { useQuery } from '../hooks/useQuery';
import { QueryDialog } from '../components/QueryDialog';
import { FormDialog } from '../components/FormDialog';
import { getFieldValue } from '../lib/formValues';
import {
  BYTES_PER_GIB,
  DEFAULT_SITE_RUNTIME_KINDS,
  SITE_RUNTIME_KINDS,
  buildTargetInput,
  targetFormValues,
} from '../lib/targetInput';
import { EXECUTION_RUNTIME_KINDS } from '../lib/runtimeValidation';
import { runtimeLabels } from '../i18n/runtime';
import { cpuArchLabels } from '../i18n/compute';
import { text } from '../i18n/catalog';

const isSite = (values: FormValues) => getFieldValue(values, 'executor') === 'site';
const isNotSite = (values: FormValues) => !isSite(values);
const isSsh = (values: FormValues) => getFieldValue(values, 'executor') === 'ssh';

/**
 * Registers or edits a compute target. A site keeps only its description here (submission mode,
 * CPU, container runtimes, arrays, queue limit); its connection lives with its launcher.
 */
export function TargetDialog({
  onClose,
  onSaved,
  target,
}: {
  onClose: () => void;
  onSaved: (target: ComputeTarget) => void;
  target?: ComputeTarget;
}) {
  const config = useQuery('target-auth-config', authApi.config);
  return (
    <QueryDialog title={target ? text.editTarget : text.newTarget} onClose={onClose} query={config}>
      {(auth) => {
        const fields: FormField[] = [
          { name: 'name', label: text.name, required: true },
          {
            name: 'executor',
            label: text.executor,
            type: 'select',
            defaultValue: 'ssh',
            options: [
              { value: 'ssh', label: text.ssh },
              ...(auth.mode === 'development' || target?.executor === 'local'
                ? [{ value: 'local', label: text.local }]
                : []),
              { value: 'site', label: text.siteExecutor },
            ],
          },
          {
            name: 'submissionMode',
            label: text.submissionMode,
            type: 'select',
            defaultValue: 'automatic',
            visible: isSite,
            options: [
              { value: 'automatic', label: text.submissionModeAutomatic },
              { value: 'manual', label: text.submissionModeManual },
            ],
          },
          { name: 'host', label: text.host, required: true, visible: isNotSite },
          {
            name: 'port',
            label: text.port,
            type: 'number',
            required: true,
            min: 1,
            max: 65535,
            defaultValue: '22',
            visible: isNotSite,
          },
          { name: 'username', label: text.sshUsername, required: true, visible: isNotSite },
          { name: 'sshKeyPath', label: text.sshKeyPath, required: true, visible: isSsh },
          { name: 'knownHostsPath', label: text.knownHostsPath, required: true, visible: isSsh },
          { name: 'workDirectory', label: text.workDirectory, required: true, visible: isNotSite },
          {
            name: 'pythonExecutable',
            label: text.pythonExecutable,
            required: true,
            defaultValue: 'python3',
            visible: isNotSite,
          },
          {
            name: 'cpuArch',
            label: text.cpuArch,
            type: 'select',
            defaultValue: 'amd64',
            options: CPU_ARCHES.map((arch) => ({ value: arch, label: cpuArchLabels[arch] })),
          },
          {
            name: 'runtimeKinds',
            label: text.runtimeKinds,
            type: 'multiselect',
            required: true,
            defaultValue: ['python'],
            visible: isNotSite,
            options: EXECUTION_RUNTIME_KINDS.map((kind) => ({
              value: kind,
              label: runtimeLabels[kind],
            })),
          },
          {
            name: 'siteRuntimeKinds',
            label: text.siteRuntimeKinds,
            type: 'multiselect',
            required: true,
            defaultValue: DEFAULT_SITE_RUNTIME_KINDS,
            visible: isSite,
            options: SITE_RUNTIME_KINDS.map((kind) => ({ value: kind, label: runtimeLabels[kind] })),
          },
          { name: 'gpuIds', label: text.gpuIdsPerLine, type: 'textarea', visible: isNotSite },
          {
            name: 'supportsArray',
            label: text.supportsArray,
            type: 'checkbox',
            defaultValue: 'false',
            visible: isSite,
          },
          {
            name: 'queueTimeout',
            label: text.queueTimeout,
            placeholder: text.queueTimeoutPlaceholder,
            visible: isSite,
          },
          {
            name: 'maxConcurrentJobs',
            label: text.maxConcurrentJobs,
            type: 'number',
            required: true,
            min: 1,
            max: 128,
            defaultValue: '1',
          },
          {
            name: 'datasetTransfer',
            label: text.datasetTransfer,
            type: 'select',
            defaultValue: 'relay',
            visible: isNotSite,
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
            defaultValue: String(DEFAULT_DATASET_CACHE_MAX_BYTES / BYTES_PER_GIB),
          },
          { name: 'enabled', label: text.enabled, type: 'checkbox', defaultValue: 'true' },
        ];
        const saved = target ? targetFormValues(target) : undefined;
        return (
          <FormDialog
            title={target ? text.editTarget : text.newTarget}
            onClose={onClose}
            onSaved={onSaved}
            fields={fields.map((field) => ({
              ...field,
              defaultValue: saved?.[field.name] ?? field.defaultValue,
            }))}
            notice={(values) =>
              isSite(values) && <p className="notice">{text.siteTargetNotice}</p>
            }
            onSubmit={(values) => {
              const input = buildTargetInput(values, target);
              return target
                ? executionApi.updateTarget(target.id, input)
                : executionApi.createTarget(input);
            }}
          />
        );
      }}
    </QueryDialog>
  );
}
