import { hashSecret, randomSecret } from './secrets.js';

// Job tokens carry their own prefix so authentication can route them to the job_tokens table
// without first probing api_tokens, and so a leaked value is recognizable as Job-scoped.
// Regular API tokens start with `mmt_`, which never matches `mmtj_`.
export const JOB_TOKEN_PREFIX = 'mmtj_';

// What a Job's code may do with its token; the write guard narrows it further to one Run.
export const JOB_TOKEN_SCOPES = ['read', 'runs:write', 'artifacts:write', 'registry:write'];

export function isJobToken(bearer: string): boolean {
  return bearer.startsWith(JOB_TOKEN_PREFIX);
}

export function createJobTokenSecret(): { token: string; tokenHash: string } {
  const token = `${JOB_TOKEN_PREFIX}${randomSecret()}`;
  return { token, tokenHash: hashSecret(token) };
}
