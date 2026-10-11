import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { UserSearchResult } from '@mmt/contracts';
import { useUserSearch } from '../hooks/useUserSearch';
import { isComposingKey } from '../lib/imeComposition';
import { ErrorNotice } from './Feedback';
import { UserSummary } from './UserSummary';
import { text } from '../i18n/catalog';

/**
 * Searches users by the start of their name, email or username and reports the one clicked.
 * Users in `excludedUserIds` (already chosen, or the signed-in user) are not offered. The field
 * empties after a pick and takes the focus back, so the next user can be searched. Enter never
 * submits the form around the field; it picks the user when the search found exactly one.
 * `autoFocus` focuses the field when it appears in place of a chosen user.
 */
export function UserSearchField({
  label,
  isRequired = false,
  excludedUserIds = [],
  autoFocus = false,
  onPick,
}: {
  label: string;
  isRequired?: boolean;
  excludedUserIds?: readonly string[];
  autoFocus?: boolean;
  onPick: (user: UserSearchResult) => void;
}) {
  const inputId = useId();
  const resultsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const search = useUserSearch(query);
  const users = search.users.filter((user) => !excludedUserIds.includes(user.id));
  const pick = (user: UserSearchResult) => {
    onPick(user);
    setQuery('');
    // The picked user's button disappears; without this the focus would drop to the page.
    inputRef.current?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || isComposingKey(event)) return;
    // The field sits inside dialog forms (creating a Project, adding a member), where Enter would
    // submit the form before a user is picked.
    event.preventDefault();
    const onlyMatch = users.length === 1 ? users[0] : undefined;
    if (onlyMatch) pick(onlyMatch);
  };
  return (
    <div className="field">
      <label htmlFor={inputId}>
        {label}
        {isRequired && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        value={query}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={text.userSearchPlaceholder}
        aria-controls={resultsId}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div id={resultsId} aria-live="polite">
        <ErrorNotice message={search.error} />
        {search.searching ? (
          <p className="muted">{text.loading}</p>
        ) : search.hasQuery && !search.error && !users.length ? (
          <p className="muted">{text.userSearchNoResults}</p>
        ) : (
          users.length > 0 && (
            <ul className="user-picker-results">
              {users.map((user) => (
                <li key={user.id}>
                  <button type="button" onClick={() => pick(user)}>
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
