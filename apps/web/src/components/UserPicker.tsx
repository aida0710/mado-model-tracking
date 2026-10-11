import type { UserSearchResult } from '@mmt/contracts';
import { UserSearchField } from './UserSearchField';
import { UserSummary } from './UserSummary';
import { text } from '../i18n/catalog';

/**
 * Finds one user by the start of their name, email or username and shows the one picked. The
 * search field and the chosen user replace each other, so the one that appears takes the focus
 * (it would otherwise drop to the page). In a dialog that opens with this, the dialog still decides
 * the first focus: `autoFocus` runs before `showModal`, which moves the focus again.
 */
export function UserPicker({
  label,
  selectedUser,
  onSelect,
}: {
  label: string;
  selectedUser: UserSearchResult | null;
  onSelect: (user: UserSearchResult | null) => void;
}) {
  if (selectedUser)
    return (
      <div className="field">
        <span>{label}</span>
        <div className="user-picker-selected">
          <UserSummary user={selectedUser} />
          <button
            type="button"
            className="button small"
            autoFocus
            onClick={() => onSelect(null)}
          >
            {text.changeSelectedUser}
          </button>
        </div>
      </div>
    );
  return <UserSearchField label={label} isRequired autoFocus onPick={onSelect} />;
}
