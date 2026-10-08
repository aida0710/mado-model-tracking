import type { AuthConfig } from '@mmt/contracts';

export interface LoginMethods {
  development: boolean;
  sso: { label: string; loginUrl: string } | null;
  local: boolean;
}

// development mode offers only its own form; local/oidc/hybrid follow the server's methods.
export function loginMethods(config: AuthConfig): LoginMethods {
  if (config.mode === 'development') return { development: true, sso: null, local: false };
  return { development: false, sso: config.methods.oidc, local: config.methods.local };
}
