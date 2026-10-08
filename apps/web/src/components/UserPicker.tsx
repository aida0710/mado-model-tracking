import { useId, useState } from 'react';
import type { UserSearchResult } from '@mmt/contracts';
import { useUserSearch } from '../hooks/useUserSearch';
import { ErrorNotice } from './Feedback';
import { text } from '../i18n/catalog';

/** Finds a user by the start of their name, email or username and reports the one picked. */
export function UserPicker({
  label,
  selectedUser,
  onSelect,
}: {
  label: string;
  selectedUser: UserSearchResult | null;
  onSelect: (user: UserSearchResult | null) => void;
}) {
  const inputId = useId();
  const resultsId = useId();
  const [query, setQuery] = useState('');
  const search = useUserSearch(query);
  if (selectedUser)
    return (
      <div className="field">
        <span>{label}</span>
        <div className="user-picker-selected">
          <UserSummary user={selectedUser} />
          <button type="button" className="button small" onClick={() => onSelect(null)}>
            {text.changeSelectedUser}
          </button>
        </div>
      </div>
    );
  return (
    <div className="field">
      <label htmlFor={inputId}>
        {label}
        <span className="required" aria-hidden="true">
          {' '}
          *
        </span>
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        autoComplete="off"
        placeholder={text.userSearchPlaceholder}
        aria-controls={resultsId}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div id={resultsId} aria-live="polite">
        <ErrorNotice message={search.error} />
        {search.searching ? (
          <p className="muted">{text.loading}</p>
        ) : search.hasQuery && !search.error && !search.users.length ? (
          <p className="muted">{text.userSearchNoResults}</p>
        ) : (
          search.users.length > 0 && (
            <ul className="user-picker-results">
              {search.users.map((user) => (
                <li key={user.id}>
                  <button type="button" onClick={() => onSelect(user)}>
                    <UserSummary user={user} />
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}

function UserSummary({ user }: { user: Pick<UserSearchResult, 'displayName' | 'email'> }) {
  return (
    <span className="user-summary">
      <span>{user.displayName}</span>
      <span className="muted">{user.email}</span>
    </span>
  );
}
