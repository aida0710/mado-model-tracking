import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { ComputeTargetDetails } from '@mmt/contracts';
import { useAuth } from '../hooks/useAuth';
import { useComputers } from '../hooks/useComputers';
import { SettingsPageHeader } from '../components/SettingsPageHeader';
import { ComputerOverviewTable } from '../components/ComputerOverviewTable';
import { ComputerDetails } from '../components/ComputerDetails';
import { ErrorNotice, Resource } from '../components/Feedback';
import { TargetDialog } from '../dialogs/TargetDialog';
import { canAddTarget } from '../lib/permissions';
import { text } from '../i18n/catalog';

type TargetDialogState = { mode: 'create' } | { mode: 'edit'; target: ComputeTargetDetails };

/**
 * 全体設定 → コンピュータ (/settings/computers), open to everyone: every computer with its owner,
 * visibility and state. Anyone adds computers here and owns what they add; a computer one may use
 * or manage opens its details below the list.
 */
export function ComputersSettingsPage() {
  const { user } = useAuth();
  const computers = useComputers();
  const [dialog, setDialog] = useState<TargetDialogState | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const selectedTarget = computers.findDetails(selectedTargetId);
  const openEditor = (targetId: string) => {
    const target = computers.findDetails(targetId);
    if (target) setDialog({ mode: 'edit', target });
  };
  return (
    <section className="management-page" data-testid="computers-settings">
      <SettingsPageHeader
        section="computers"
        actions={
          <>
            {canAddTarget(user) && (
              <button className="button primary" onClick={() => setDialog({ mode: 'create' })}>
                <Plus size={15} />
                {text.newTarget}
              </button>
            )}
            <button className="icon-button" aria-label={text.refresh} onClick={computers.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <p className="muted">{text.computersHint}</p>
      <ErrorNotice message={computers.mutation.error} />
      <Resource query={computers.overview}>
        {(targets) => (
          <ComputerOverviewTable
            targets={targets}
            user={user}
            selectedTargetId={selectedTargetId}
            pending={computers.mutation.pending}
            onOpen={(target) => setSelectedTargetId(target.id)}
            onEdit={(target) => openEditor(target.id)}
            onToggleEnabled={computers.toggleEnabled}
          />
        )}
      </Resource>
      {selectedTarget && (
        <ComputerDetails
          key={selectedTarget.id}
          target={selectedTarget}
          user={user}
          onTargetChanged={computers.reload}
        />
      )}
      {dialog && (
        <TargetDialog
          target={dialog.mode === 'edit' ? dialog.target : undefined}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            // A saved computer opens its details, where a site's key and job shell are.
            setSelectedTargetId(saved.id);
            computers.reload();
          }}
        />
      )}
    </section>
  );
}
