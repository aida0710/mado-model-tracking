import { useState } from 'react';
import type { ProjectGroupBinding } from '@mmt/contracts';
import { useProject } from '../hooks/useProject';
import { useGroupNameCandidates, useProjectGroupBindings } from '../hooks/useProjectGroupBindings';
import { ResponsiveTable } from './ResponsiveTable';
import { Resource } from './Feedback';
import { ConfirmDialog } from './ConfirmDialog';
import { GroupBindingDialog } from '../dialogs/GroupBindingDialog';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';
import { projectAccessTextTemplates } from '../i18n/projectAccess';

/** Roles granted to Authentik groups. `onChanged` lets the member list show the new roles. */
export function ProjectGroupBindings({ onChanged }: { onChanged: () => void }) {
  const { project, isProjectAdmin, reloadProjects } = useProject();
  const { bindings, saveGroupBinding, removeGroupBinding } = useProjectGroupBindings(project.id);
  const [editing, setEditing] = useState<ProjectGroupBinding | 'new' | null>(null);
  const [removing, setRemoving] = useState<ProjectGroupBinding | null>(null);
  const reloadAfterChange = () => {
    bindings.reload();
    onChanged();
    reloadProjects();
  };
  return (
    <section className="settings-section">
      <div className="section-heading">
        <h2>{text.groupBindings}</h2>
        {isProjectAdmin && (
          <button className="button small" onClick={() => setEditing('new')}>
            {text.addGroupBinding}
          </button>
        )}
      </div>
      <p className="muted">{text.groupBindingsDescription}</p>
      <Resource query={bindings}>
        {(items) => (
          <ResponsiveTable
            rows={items}
            rowKey={(binding) => binding.group}
            empty={text.groupBindingsEmpty}
            columns={[
              {
                key: 'group',
                priority: 'primary',
                header: text.groupName,
                className: 'mono',
                render: (binding) => binding.group,
              },
              {
                key: 'role',
                priority: 'primary',
                header: text.role,
                render: (binding) => text[binding.role],
              },
              {
                key: 'createdAt',
                priority: 'secondary',
                header: text.grantedAt,
                render: (binding) => formatDate(binding.createdAt),
              },
              ...(isProjectAdmin
                ? [
                    {
                      key: 'actions',
                      priority: 'secondary' as const,
                      header: text.actions,
                      render: (binding: ProjectGroupBinding) => (
                        <div className="access-actions">
                          <button className="button small" onClick={() => setEditing(binding)}>
                            {text.edit}
                          </button>
                          <button
                            className="button small danger"
                            onClick={() => setRemoving(binding)}
                          >
                            {text.remove}
                          </button>
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Resource>
      {editing && (
        <GroupBindingEditor
          binding={editing === 'new' ? undefined : editing}
          existingBindings={bindings.value ?? []}
          onSave={saveGroupBinding}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reloadAfterChange();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={text.removeGroupBinding}
          message={projectAccessTextTemplates.removeGroupBindingConfirm(removing.group)}
          confirmLabel={text.remove}
          destructive
          onClose={() => setRemoving(null)}
          onConfirm={() => removeGroupBinding(removing.group)}
          onConfirmed={() => {
            setRemoving(null);
            reloadAfterChange();
          }}
        />
      )}
    </section>
  );
}

// Group names are fetched only while the dialog is open, since only admins ever open it.
function GroupBindingEditor(
  props: Omit<Parameters<typeof GroupBindingDialog>[0], 'groupNameCandidates'>,
) {
  const groupNameCandidates = useGroupNameCandidates();
  return <GroupBindingDialog {...props} groupNameCandidates={groupNameCandidates} />;
}
