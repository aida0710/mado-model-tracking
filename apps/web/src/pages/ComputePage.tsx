import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { executionApi } from '../api/execution';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { Resource } from '../components/Feedback';
import { TargetDialog } from '../dialogs/TargetDialog';
import { text } from '../i18n/catalog';
import { runtimeLabels } from '../i18n/runtime';

export function ComputePage() {
  const { user } = useAuth();
  const { project } = useProject();
  const [showDialog, setShowDialog] = useState(false);
  const targets = useQuery('compute-targets', executionApi.targets);
  return (
    <section className="page">
      <PageHeader
        title={text.compute}
        eyebrow={project.name}
        actions={
          <>
            {user.isAdmin && (
              <button className="button primary" onClick={() => setShowDialog(true)}>
                <Plus size={15} />
                {text.newTarget}
              </button>
            )}
            <button className="icon-button" aria-label={text.refresh} onClick={targets.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <Resource query={targets}>
        {(items) => (
          <DataTable
            items={items}
            rowKey={(target) => target.id}
            empty={text.noTargets}
            columns={[
              { key: 'name', label: text.name, render: (target) => target.name },
              {
                key: 'host',
                label: text.host,
                className: 'mono',
                render: (target) =>
                  target.host ? `${target.username}@${target.host}:${target.port}` : '—',
              },
              { key: 'executor', label: text.executor, render: (target) => target.executor },
              {
                key: 'runtime',
                label: text.runtimeKinds,
                render: (target) =>
                  target.runtimeKinds.map((kind) => runtimeLabels[kind]).join(', '),
              },
              {
                key: 'gpu',
                label: text.gpuIds,
                className: 'mono',
                render: (target) => target.gpuIds.join(', ') || text.cpuOnly,
              },
              {
                key: 'concurrent',
                label: text.maxConcurrentJobs,
                className: 'mono',
                render: (target) => target.maxConcurrentJobs,
              },
              {
                key: 'enabled',
                label: text.enabled,
                render: (target) => (
                  <input
                    type="checkbox"
                    checked={target.enabled}
                    readOnly
                    disabled
                    aria-label={text.enabled}
                  />
                ),
              },
            ]}
          />
        )}
      </Resource>
      {showDialog && (
        <TargetDialog
          onClose={() => setShowDialog(false)}
          onSaved={() => {
            setShowDialog(false);
            targets.reload();
          }}
        />
      )}
    </section>
  );
}
