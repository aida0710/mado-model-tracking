import type { User } from '@mmt/contracts';
import { text } from '../i18n/catalog';

/** SSO users get their global role and display name from Authentik at every login. */
export function isSsoUser(user: Pick<User, 'authSources'>): boolean {
  return user.authSources.includes('oidc');
}

/**
 * Login methods as shown in the users table and the account page. Service Accounts have no login
 * method and act only through tokens; development logins hold neither and are not Service Accounts.
 */
export function userAuthSourceLabels(user: Pick<User, 'authSources' | 'kind'>): string[] {
  if (user.kind === 'service') return [text.userAuthServiceToken];
  if (user.authSources.length === 0) return [text.userAuthNone];
  return user.authSources.map((source) =>
    source === 'local' ? text.userAuthLocal : text.userAuthSso,
  );
}
