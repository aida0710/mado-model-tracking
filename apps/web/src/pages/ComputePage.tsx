import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { ComputeTarget } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { useMutation } from '../hooks/useMutation';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { WorkerPresenceTable } from '../components/WorkerPresenceTable';
import { ErrorNotice, Resource } from '../components/Feedback';
import { TargetDialog } from '../dialogs/TargetDialog';
import { text } from '../i18n/catalog';
import { runtimeLabels } from '../i18n/runtime';

export function ComputePage() {
  const { user } = useAuth();
  const { project } = useProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingTarget, setEditingTarget] = useState<ComputeTarget | undefined>();
  const mutation = useMutation();
  const targets = useQuery('compute-targets', executionApi.targets);
  const workers = useQuery(
    `${project.id}:workers`,
    (signal) => executionApi.workers(project.id, signal),
    EXECUTION_POLL_MS,
  );
  return (
    <section className="page">
      <PageHeader
        title={text.compute}
        eyebrow={project.name}
        actions={
          <>
            {user.isAdmin && (
              <button className="button primary" onClick={() => { setEditingTarget(undefined); setShowDialog(true); }}>
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
      <ErrorNotice message={mutation.error} />
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
                    disabled={!user.isAdmin || mutation.pending}
                    aria-label={`${target.enabled ? text.disableTarget : text.enableTarget}: ${target.name}`}
                    onChange={() => void mutation.run(() => executionApi.updateTarget(target.id, { enabled: !target.enabled }))
                      .then((saved) => { if (saved) targets.reload(); })}
                  />
                ),
              },
              { key: 'edit', label: text.edit, render: (target) => user.isAdmin && <button className="button small"
                data-testid={`target-edit-${target.id}`} onClick={() => { setEditingTarget(target); setShowDialog(true); }}>{text.editTarget}</button> },
            ]}
          />
        )}
      </Resource>
      <section className="settings-section">
        <div className="section-heading">
          <h2>{text.workers}</h2>
        </div>
        <Resource query={workers}>
          {(items) => <WorkerPresenceTable workers={items} targets={targets.value ?? []} />}
        </Resource>
      </section>
      {showDialog && (
        <TargetDialog
          target={editingTarget}
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
