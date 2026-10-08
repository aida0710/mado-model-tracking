import type { User } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import type { JobTokenBinding } from '../auth/principal.js';
import { userColumns } from './identityRepository.js';

export interface JobTokenIdentity {
  user: User;
  tokenId: string;
  projectId: string;
  job: JobTokenBinding;
}

// A token stays usable only while its Job holds the same lease and has not reached a terminal
// state: completion, cancellation, or a lease change ends it without touching job_tokens.
const ACTIVE_JOB_TOKEN = `t.revoked_at IS NULL AND j.lease_id=t.lease_id AND j.status IN ('claimed','running')
  AND u.status='active'`;

export async function jobTokenIdentity(
  connection: Connection,
  tokenHash: string,
): Promise<JobTokenIdentity | undefined> {
  const identity = await first<
    User & { tokenId: string; projectId: string; jobId: string; runId: string; leaseId: string }
  >(
    connection,
    `SELECT ${userColumns},t.id AS token_id,t.project_id,t.job_id,t.run_id,t.lease_id
    FROM job_tokens t JOIN jobs j ON j.id=t.job_id AND j.project_id=t.project_id JOIN users u ON u.id=t.user_id
    WHERE t.token_hash=$1 AND ${ACTIVE_JOB_TOKEN}`,
    [tokenHash],
  );
  if (!identity) return undefined;
  const { tokenId, projectId, jobId, runId, leaseId, ...user } = identity;
  return { user, tokenId, projectId, job: { jobId, runId, leaseId } };
}

// Re-checks a token inside a write transaction; FOR SHARE on the Job blocks a concurrent completion.
export async function isJobTokenActive(
  connection: Connection,
  token: { id: string; userId: string; lock?: boolean },
): Promise<boolean> {
  const active = await first(
    connection,
    `SELECT t.id FROM job_tokens t JOIN jobs j ON j.id=t.job_id AND j.project_id=t.project_id JOIN users u ON u.id=t.user_id
    WHERE t.id=$1 AND t.user_id=$2 AND ${ACTIVE_JOB_TOKEN} ${token.lock ? 'FOR SHARE OF j' : ''}`,
    [token.id, token.userId],
  );
  return !!active;
}

export async function insertJobToken(
  connection: Connection,
  token: {
    projectId: string;
    jobId: string;
    leaseId: string;
    runId: string;
    userId: string;
    tokenHash: string;
  },
): Promise<void> {
  await connection.query(
    'INSERT INTO job_tokens(project_id,job_id,lease_id,run_id,user_id,token_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [token.projectId, token.jobId, token.leaseId, token.runId, token.userId, token.tokenHash],
  );
}

export async function revokeJobTokens(connection: Connection, jobId: string): Promise<void> {
  await connection.query(
    'UPDATE job_tokens SET revoked_at=now() WHERE job_id=$1 AND revoked_at IS NULL',
    [jobId],
  );
}

export async function findLoggedModelSourceRunId(
  connection: Connection,
  model: { projectId: string; id: string },
): Promise<string | null> {
  const found = await first<{ sourceRunId: string | null }>(
    connection,
    'SELECT source_run_id FROM mlflow_logged_models WHERE id=$1 AND project_id=$2',
    [model.id, model.projectId],
  );
  return found?.sourceRunId ?? null;
}

// artifact_uploads is created by the artifact upload sessions migration (018).
export async function findArtifactUploadRunId(
  connection: Connection,
  upload: { projectId: string; id: string },
): Promise<string | null> {
  const found = await first<{ runId: string | null }>(
    connection,
    'SELECT run_id FROM artifact_uploads WHERE id=$1 AND project_id=$2',
    [upload.id, upload.projectId],
  );
  return found?.runId ?? null;
}
