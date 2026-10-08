import { DEFAULT_DATASET_CACHE_MAX_BYTES, type ComputeTarget } from '@mmt/contracts';
import type { FormField } from '../types/form';
import { executionApi } from '../api/execution';
import { authApi } from '../api/auth';
import { useQuery } from '../hooks/useQuery';
import { QueryDialog } from '../components/QueryDialog';
import { FormDialog } from '../components/FormDialog';
import { getFieldValue } from '../lib/formValues';
import { BYTES_PER_GIB, buildTargetInput } from '../lib/targetInput';
import { EXECUTION_RUNTIME_KINDS } from '../lib/runtimeValidation';
import { runtimeLabels } from '../i18n/runtime';
import { text } from '../i18n/catalog';

function datasetCacheGiB(target: ComputeTarget): string {
  return String(Math.max(1, Math.round(target.datasetCacheMaxBytes / BYTES_PER_GIB)));
}

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
      {(auth) => (
        <FormDialog
          title={target ? text.editTarget : text.newTarget}
          fullScreenOnNarrow
          onClose={onClose}
          onSaved={onSaved}
          fields={([
            { name: 'name', label: text.name, required: true },
            {
              name: 'executor',
              label: text.executor,
              type: 'select',
              defaultValue: 'ssh',
              options: [
                { value: 'ssh', label: text.ssh },
                ...(auth.mode === 'development' || target?.executor === 'local' ? [{ value: 'local', label: text.local }] : []),
              ],
            },
            { name: 'host', label: text.host, required: true },
            {
              name: 'port',
              label: text.port,
              type: 'number',
              required: true,
              min: 1,
              max: 65535,
              defaultValue: '22',
            },
            { name: 'username', label: text.sshUsername, required: true },
            {
              name: 'sshKeyPath',
              label: text.sshKeyPath,
              required: true,
              visible: (values) => getFieldValue(values, 'executor') === 'ssh',
            },
            {
              name: 'knownHostsPath',
              label: text.knownHostsPath,
              required: true,
              visible: (values) => getFieldValue(values, 'executor') === 'ssh',
            },
            { name: 'workDirectory', label: text.workDirectory, required: true },
            {
              name: 'pythonExecutable',
              label: text.pythonExecutable,
              required: true,
              defaultValue: 'python3',
            },
            {
              name: 'runtimeKinds',
              label: text.runtimeKinds,
              type: 'multiselect',
              required: true,
              defaultValue: ['python'],
              options: EXECUTION_RUNTIME_KINDS.map((kind) => ({
                value: kind,
                label: runtimeLabels[kind],
              })),
            },
            { name: 'gpuIds', label: text.gpuIdsPerLine, type: 'textarea' },
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
          ] satisfies FormField[]).map((field) => {
            if (!target) return field;
            if (field.name === 'datasetCacheMaxGiB')
              return { ...field, defaultValue: datasetCacheGiB(target) };
            const value = target[field.name as keyof ComputeTarget];
            return { ...field, defaultValue: field.name === 'gpuIds' ? target.gpuIds.join('\n') : Array.isArray(value) ? value : String(value) };
          })}
          onSubmit={(values) => {
            const input = buildTargetInput(values);
            // A bound set through the API in bytes is kept unless the GiB field was edited.
            if (target && getFieldValue(values, 'datasetCacheMaxGiB') === datasetCacheGiB(target))
              input.datasetCacheMaxBytes = target.datasetCacheMaxBytes;
            return target ? executionApi.updateTarget(target.id, input) : executionApi.createTarget(input);
          }}
        />
      )}
    </QueryDialog>
  );
}
