import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { ComputeTarget } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { useMutation } from '../hooks/useMutation';
import { PageHeader } from '../components/PageHeader';
import { ComputeTargetsTable } from '../components/ComputeTargetsTable';
import { WorkerPresenceTable } from '../components/WorkerPresenceTable';
import { ErrorNotice, Resource } from '../components/Feedback';
import { TargetDialog } from '../dialogs/TargetDialog';
import { TargetCheckPanel } from '../components/TargetCheckPanel';
import { text } from '../i18n/catalog';

export function ComputePage() {
  const { user } = useAuth();
  const { project } = useProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingTarget, setEditingTarget] = useState<ComputeTarget | undefined>();
  const [checkedTargetId, setCheckedTargetId] = useState<string | null>(null);
  const mutation = useMutation();
  const targets = useQuery('compute-targets', executionApi.targets);
  const workers = useQuery(
    `${project.id}:workers`,
    (signal) => executionApi.workers(project.id, signal),
    EXECUTION_POLL_MS,
  );
  const checkedTarget = targets.value?.find((target) => target.id === checkedTargetId);
  return (
    <section className="page management-page">
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
          <ComputeTargetsTable
            targets={items}
            canManage={user.isAdmin}
            pending={mutation.pending}
            onToggleEnabled={(target) =>
              void mutation
                .run(() => executionApi.updateTarget(target.id, { enabled: !target.enabled }))
                .then((saved) => {
                  if (saved) targets.reload();
                })
            }
            onEdit={(target) => {
              setEditingTarget(target);
              setShowDialog(true);
            }}
            onCheck={(target) => setCheckedTargetId(target.id)}
          />
        )}
      </Resource>
      {checkedTarget && (
        <TargetCheckPanel key={checkedTarget.id} target={checkedTarget} onTargetSaved={targets.reload} />
      )}
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
