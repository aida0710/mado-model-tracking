import type { User } from '@mmt/contracts';

export type SessionAuthMethod = 'local' | 'oidc' | 'development';

// The Job a Job token was issued for; its writes are limited to this Run.
export interface JobTokenBinding {
  jobId: string;
  runId: string;
  leaseId: string;
}

export interface Principal {
  user: User;
  method: 'session' | 'token';
  // `job` is set only for Job tokens (mmtj_); its `id` then refers to job_tokens, not api_tokens.
  token: {
    id: string;
    projectId: string | null;
    scopes: string[];
    job?: JobTokenBinding;
  } | null;
  // Browser sessions only; absent for API tokens and for principals built inside the server (seed).
  session?: { tokenHash: string; authMethod: SessionAuthMethod; mustChangePassword: boolean };
}
