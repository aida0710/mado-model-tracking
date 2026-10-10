import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { ComputeTargetDetails } from '@mmt/contracts';
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
import { SiteComputerDetails } from '../components/SiteComputerDetails';
import { canAddTarget, canManageTarget } from '../lib/permissions';
import { text } from '../i18n/catalog';

type TargetDialogState = { mode: 'create' } | { mode: 'edit'; target: ComputeTargetDetails };

/**
 * Every computer the signed-in person may see, open to everyone: researchers add sites of their
 * own here, and the chosen computer's details (a site's settings, or a worker's check) follow.
 */
export function ComputePage() {
  const { user } = useAuth();
  const { project, projects } = useProject();
  const [dialog, setDialog] = useState<TargetDialogState | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const mutation = useMutation();
  const targets = useQuery('compute-targets', executionApi.targets);
  const workers = useQuery(
    `${project.id}:workers`,
    (signal) => executionApi.workers(project.id, signal),
    EXECUTION_POLL_MS,
  );
  const selectedTarget = targets.value?.find((target) => target.id === selectedTargetId);
  return (
    <section className="page management-page">
      <PageHeader
        title={text.compute}
        eyebrow={project.name}
        actions={
          <>
            {canAddTarget(user) && (
              <button className="button primary" onClick={() => setDialog({ mode: 'create' })}>
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
            user={user}
            projects={projects}
            selectedTargetId={selectedTargetId}
            pending={mutation.pending}
            onSelect={(target) => setSelectedTargetId(target.id)}
            onToggleEnabled={(target) =>
              void mutation
                .run(() => executionApi.updateTarget(target.id, { enabled: !target.enabled }))
                .then((saved) => {
                  if (saved) targets.reload();
                })
            }
            onEdit={(target) => setDialog({ mode: 'edit', target })}
          />
        )}
      </Resource>
      {selectedTarget?.executor === 'site' && (
        <SiteComputerDetails
          key={selectedTarget.id}
          target={selectedTarget}
          user={user}
          onTargetChanged={targets.reload}
        />
      )}
      {selectedTarget &&
        selectedTarget.executor !== 'site' &&
        canManageTarget(user, selectedTarget) && (
          <TargetCheckPanel
            key={selectedTarget.id}
            target={selectedTarget}
            onTargetSaved={targets.reload}
          />
        )}
      <section className="settings-section">
        <div className="section-heading">
          <h2>{text.workers}</h2>
        </div>
        <Resource query={workers}>
          {(items) => <WorkerPresenceTable workers={items} targets={targets.value ?? []} />}
        </Resource>
      </section>
      {dialog && (
        <TargetDialog
          target={dialog.mode === 'edit' ? dialog.target : undefined}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            // A saved site opens its details, where its key and job shell are.
            if (saved.executor === 'site') setSelectedTargetId(saved.id);
            targets.reload();
          }}
        />
      )}
    </section>
  );
}
