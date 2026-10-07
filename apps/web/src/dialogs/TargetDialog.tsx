import type { ComputeTarget } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { authApi } from '../api/auth';
import { useQuery } from '../hooks/useQuery';
import { QueryDialog } from '../components/QueryDialog';
import { FormDialog } from '../components/FormDialog';
import { getFieldValue, splitLines, parsePositiveInteger } from '../lib/formValues';
import { text } from '../i18n/catalog';

export function TargetDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (target: ComputeTarget) => void;
}) {
  const config = useQuery('target-auth-config', authApi.config);
  return (
    <QueryDialog title={text.newTarget} onClose={onClose} query={config}>
      {(auth) => (
        <FormDialog
          title={text.newTarget}
          onClose={onClose}
          onSaved={onSaved}
          fields={[
            { name: 'name', label: text.name, required: true },
            {
              name: 'executor',
              label: text.executor,
              type: 'select',
              defaultValue: 'ssh',
              options: [
                { value: 'ssh', label: text.ssh },
                ...(auth.mode === 'development' ? [{ value: 'local', label: text.local }] : []),
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
            { name: 'username', label: text.username, required: true },
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
            { name: 'gpuIds', label: `${text.gpuIds}（1行に1件）`, type: 'textarea' },
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
          ]}
          onSubmit={(values) =>
            executionApi.createTarget({
              name: getFieldValue(values, 'name'),
              executor: getFieldValue(values, 'executor') as ComputeTarget['executor'],
              host: getFieldValue(values, 'host'),
              port: parsePositiveInteger(getFieldValue(values, 'port')),
              username: getFieldValue(values, 'username'),
              sshKeyPath: getFieldValue(values, 'sshKeyPath'),
              knownHostsPath: getFieldValue(values, 'knownHostsPath'),
              workDirectory: getFieldValue(values, 'workDirectory'),
              pythonExecutable: getFieldValue(values, 'pythonExecutable'),
              gpuIds: splitLines(getFieldValue(values, 'gpuIds')),
              maxConcurrentJobs: parsePositiveInteger(getFieldValue(values, 'maxConcurrentJobs')),
              enabled: getFieldValue(values, 'enabled') === 'true',
            })
          }
        />
      )}
    </QueryDialog>
  );
}
