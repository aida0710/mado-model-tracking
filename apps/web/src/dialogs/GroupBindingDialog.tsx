import { useId, useState } from 'react';
import type { ProjectGroupBinding, ProjectRole } from '@mmt/contracts';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { ProjectRoleSelect } from '../components/ProjectRoleSelect';
import { useMutation } from '../hooks/useMutation';
import { text } from '../i18n/catalog';

/**
 * Grants a role to an Authentik group, or changes the role of an existing binding.
 * The group name is the binding's key, so it can only be chosen when adding.
 */
export function GroupBindingDialog({
  binding,
  groupNameCandidates,
  onSave,
  onSaved,
  onClose,
}: {
  binding?: ProjectGroupBinding;
  groupNameCandidates: string[];
  onSave: (group: string, role: ProjectRole) => Promise<unknown>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const groupInputId = useId();
  const candidatesId = useId();
  const [group, setGroup] = useState(binding?.group ?? '');
  const [role, setRole] = useState<ProjectRole>(binding?.role ?? 'viewer');
  const mutation = useMutation();
  return (
    <Dialog
      title={binding ? text.editGroupBinding : text.addGroupBinding}
      onClose={onClose}
      busy={mutation.pending}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutation
            .run(async () => {
              await onSave(group.trim(), role);
              return true;
            })
            .then((saved) => {
              if (saved) onSaved();
            });
        }}
      >
        <fieldset disabled={mutation.pending}>
          <div className="field">
            <label htmlFor={groupInputId}>
              {text.groupName}
              <span className="required" aria-hidden="true">
                {' '}
                *
              </span>
            </label>
            <input
              id={groupInputId}
              value={group}
              required
              readOnly={binding !== undefined}
              autoComplete="off"
              list={binding ? undefined : candidatesId}
              onChange={(event) => setGroup(event.target.value)}
            />
            {!binding && (
              <>
                <datalist id={candidatesId}>
                  {groupNameCandidates.map((candidate) => (
                    <option key={candidate} value={candidate} />
                  ))}
                </datalist>
                <span className="muted">{text.groupNameHint}</span>
              </>
            )}
          </div>
          <ProjectRoleSelect label={text.role} value={role} onChange={setRole} />
        </fieldset>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={mutation.pending}>
            {mutation.pending ? text.loading : text.save}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
