import type { ProjectRole } from '@mmt/contracts';
import { useAuth } from '../hooks/useAuth';
import {
  addMemberGrant,
  changeMemberGrantRole,
  removeMemberGrant,
  type MemberGrantDraft,
} from '../lib/projectMemberGrants';
import { ProjectRoleOptions } from './ProjectRoleSelect';
import { UserSearchField } from './UserSearchField';
import { UserSummary } from './UserSummary';
import { text, textTemplates } from '../i18n/catalog';

/**
 * The members a new Project starts with: users found by search, each with a role to change and a
 * button to take them off. The creator becomes the Project admin anyway, so they are not offered.
 */
export function ProjectMemberGrantsField({
  drafts,
  onChange,
}: {
  drafts: MemberGrantDraft[];
  onChange: (drafts: MemberGrantDraft[]) => void;
}) {
  const { user: creator } = useAuth();
  const excludedUserIds = [creator.id, ...drafts.map((draft) => draft.user.id)];
  return (
    <fieldset className="member-grants">
      <legend>{text.projectInitialMembers}</legend>
      <p className="muted">{text.projectInitialMembersHint}</p>
      <UserSearchField
        label={text.addMember}
        excludedUserIds={excludedUserIds}
        onPick={(user) => onChange(addMemberGrant(drafts, user))}
      />
      {drafts.length > 0 && (
        <ul className="member-grants-list">
          {drafts.map(({ user, role }) => (
            <li key={user.id}>
              <UserSummary user={user} />
              <select
                aria-label={textTemplates.projectMemberRole(user.displayName)}
                value={role}
                onChange={(event) =>
                  onChange(
                    changeMemberGrantRole(drafts, {
                      userId: user.id,
                      role: event.target.value as ProjectRole,
                    }),
                  )
                }
              >
                <ProjectRoleOptions />
              </select>
              <button
                type="button"
                className="button small"
                aria-label={textTemplates.projectMemberRemove(user.displayName)}
                onClick={() => onChange(removeMemberGrant(drafts, user.id))}
              >
                {text.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
