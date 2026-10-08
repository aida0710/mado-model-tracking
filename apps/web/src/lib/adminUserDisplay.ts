import type { User } from '@mmt/contracts';
import { text } from '../i18n/catalog';

/** SSO users get their global role and display name from Authentik at every login. */
export function isSsoUser(user: Pick<User, 'authSources'>): boolean {
  return user.authSources.includes('oidc');
}

/** Login methods as shown in the users table and /account; development logins hold neither. */
export function userAuthSourceLabels(user: Pick<User, 'authSources'>): string[] {
  if (user.authSources.length === 0) return [text.userAuthNone];
  return user.authSources.map((source) =>
    source === 'local' ? text.userAuthLocal : text.userAuthSso,
  );
}
