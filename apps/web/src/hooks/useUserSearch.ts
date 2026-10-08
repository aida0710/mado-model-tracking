import { useEffect, useState } from 'react';
import { accessApi } from '../api/access';
import { useQuery } from './useQuery';

// Wait until typing pauses so each keystroke does not send its own search request.
export const USER_SEARCH_DEBOUNCE_MS = 300;

/** Users whose name, email or username starts with `query`, searched once typing pauses. */
export function useUserSearch(query: string) {
  const trimmedQuery = query.trim();
  const [settledQuery, setSettledQuery] = useState(trimmedQuery);
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(trimmedQuery), USER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmedQuery]);
  // useQuery aborts the previous request when the key changes, so late answers never win.
  const search = useQuery(settledQuery ? `user-search:${settledQuery}` : null, (signal) =>
    accessApi.searchUsers(settledQuery, signal),
  );
  const isWaiting = trimmedQuery !== settledQuery;
  return {
    users: isWaiting ? [] : (search.value ?? []),
    searching: trimmedQuery !== '' && (isWaiting || search.loading),
    hasQuery: trimmedQuery !== '',
    error: isWaiting ? null : search.error,
  };
}
