import { useState } from 'react';
import type { ProjectMember, ProjectRole, UserSearchResult } from '@mmt/contracts';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { ProjectRoleSelect } from '../components/ProjectRoleSelect';
import { UserPicker } from '../components/UserPicker';
import { useMutation } from '../hooks/useMutation';
import { text } from '../i18n/catalog';

/**
 * Adds a member by searching users, or changes the direct role of an existing member.
 * Pass `member` to edit; its direct role is the starting value because only that is edited here.
 */
export function MemberDialog({
  member,
  onSave,
  onSaved,
  onClose,
}: {
  member?: ProjectMember;
  onSave: (userId: string, role: ProjectRole) => Promise<unknown>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(
    member ? member.user : null,
  );
  const [role, setRole] = useState<ProjectRole>(member?.directRole ?? 'viewer');
  const [showUserRequired, setShowUserRequired] = useState(false);
  const mutation = useMutation();
  return (
    <Dialog
      title={member ? text.editMember : text.addMember}
      onClose={onClose}
      busy={mutation.pending}
      fullScreenOnNarrow
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedUser) {
            setShowUserRequired(true);
            return;
          }
          void mutation
            .run(async () => {
              await onSave(selectedUser.id, role);
              return true;
            })
            .then((saved) => {
              if (saved) onSaved();
            });
        }}
      >
        <fieldset disabled={mutation.pending}>
          {member ? (
            <div className="field">
              <span>{text.memberUser}</span>
              <span>
                {member.user.displayName} <span className="muted">{member.user.email}</span>
              </span>
            </div>
          ) : (
            <UserPicker
              label={text.memberUser}
              selectedUser={selectedUser}
              onSelect={(user) => {
                setSelectedUser(user);
                setShowUserRequired(false);
              }}
            />
          )}
          <ProjectRoleSelect label={text.directRole} value={role} onChange={setRole} />
          <p className="muted">{text.directRoleHint}</p>
        </fieldset>
        <ErrorNotice message={showUserRequired ? text.userSearchRequired : mutation.error} />
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
