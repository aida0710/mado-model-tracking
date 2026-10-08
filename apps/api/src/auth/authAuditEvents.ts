import type { RequestMetadata } from '../http/requestMetadata.js';

// Shared fields of auth.login events. details never carry passwords, codes, or state values.
export function loginAudit(method: 'local' | 'oidc' | 'development', metadata: RequestMetadata) {
  return {
    action: 'auth.login',
    resourceType: 'user',
    details: { method },
    ...metadata,
  };
}
