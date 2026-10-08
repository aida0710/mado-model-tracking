import type { ComputeTarget } from '@mmt/contracts';
import type { FormField } from '../types/form';
import { executionApi } from '../api/execution';
import { authApi } from '../api/auth';
import { useQuery } from '../hooks/useQuery';
import { QueryDialog } from '../components/QueryDialog';
import { FormDialog } from '../components/FormDialog';
import { getFieldValue } from '../lib/formValues';
import { buildTargetInput } from '../lib/targetInput';
import { EXECUTION_RUNTIME_KINDS } from '../lib/runtimeValidation';
import { runtimeLabels } from '../i18n/runtime';
import { text } from '../i18n/catalog';

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
            { name: 'enabled', label: text.enabled, type: 'checkbox', defaultValue: 'true' },
          ] satisfies FormField[]).map((field) => {
            if (!target) return field;
            const value = target[field.name as keyof ComputeTarget];
            return { ...field, defaultValue: field.name === 'gpuIds' ? target.gpuIds.join('\n') : Array.isArray(value) ? value : String(value) };
          })}
          onSubmit={(values) => {
            const input = buildTargetInput(values);
            return target ? executionApi.updateTarget(target.id, input) : executionApi.createTarget(input);
          }}
        />
      )}
    </QueryDialog>
  );
}
