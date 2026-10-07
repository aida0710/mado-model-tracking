import type { User } from '@mmt/contracts';

export interface Principal {
  user: User;
  method: 'session' | 'token';
  token: { id: string; projectId: string | null; scopes: string[] } | null;
}
