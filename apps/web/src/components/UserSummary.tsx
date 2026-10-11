import type { UserSearchResult } from '@mmt/contracts';

/** A user's display name with their email under it, in search results and chosen members. */
export function UserSummary({ user }: { user: Pick<UserSearchResult, 'displayName' | 'email'> }) {
  return (
    <span className="user-summary">
      <span>{user.displayName}</span>
      <span className="muted">{user.email}</span>
    </span>
  );
}
