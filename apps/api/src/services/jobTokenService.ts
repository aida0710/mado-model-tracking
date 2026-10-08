import type { Job } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { createJobTokenSecret, JOB_TOKEN_SCOPES } from '../auth/jobTokens.js';
import { hashSecret } from '../auth/secrets.js';
import { first, type Connection, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import {
  insertJobToken,
  jobTokenIdentity,
  revokeJobTokens,
} from '../repositories/jobTokenRepository.js';

/**
 * Issues and authenticates the tokens a Job's code receives in place of the worker token.
 * The token acts as the Run's creator, so the code never gets more than that person's role.
 */
export class JobTokenService {
  constructor(private readonly database: Database) {}

  async authenticate(bearer: string): Promise<Principal> {
    const identity = await jobTokenIdentity(this.database, hashSecret(bearer));
    if (!identity)
      throw new DomainError(401, 'Job tokenが無効または失効しています', 'invalid_token');
    return {
      user: identity.user,
      method: 'token',
      token: {
        id: identity.tokenId,
        projectId: identity.projectId,
        scopes: [...JOB_TOKEN_SCOPES],
        job: identity.job,
      },
    };
  }

  /**
   * Returns a new token while the Job is still `claimed`, i.e. before any user process can hold
   * one. A repeated claim/resume (for example after a lost claim response) revokes the earlier
   * token. A `running` Job gets null: its process already has a token, kept in the worker journal.
   */
  async issueForWorker(connection: Connection, job: Job): Promise<string | null> {
    // Locking the Job serializes concurrent resumes so only one issued token survives.
    const current = await first<{
      status: Job['status'];
      leaseId: string | null;
      createdBy: string;
    }>(
      connection,
      `SELECT j.status,j.lease_id,r.created_by FROM jobs j JOIN runs r ON r.id=j.run_id AND r.project_id=j.project_id
      WHERE j.id=$1 AND j.project_id=$2 FOR UPDATE OF j`,
      [job.id, job.projectId],
    );
    if (!current || current.status !== 'claimed' || !current.leaseId) return null;
    await revokeJobTokens(connection, job.id);
    const { token, tokenHash } = createJobTokenSecret();
    await insertJobToken(connection, {
      projectId: job.projectId,
      jobId: job.id,
      leaseId: current.leaseId,
      runId: job.runId,
      userId: current.createdBy,
      tokenHash,
    });
    return token;
  }
}
