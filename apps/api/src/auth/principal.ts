import type { User } from '@mmt/contracts';

export type SessionAuthMethod = 'local' | 'oidc' | 'development';

export interface Principal {
  user: User;
  method: 'session' | 'token';
  token: { id: string; projectId: string | null; scopes: string[] } | null;
  // Browser sessions only; absent for API tokens and for principals built inside the server (seed).
  session?: { tokenHash: string; authMethod: SessionAuthMethod; mustChangePassword: boolean };
}
