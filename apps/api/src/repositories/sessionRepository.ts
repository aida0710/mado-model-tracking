import type { User } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import type { SessionAuthMethod } from '../auth/principal.js';
import { userColumns } from './identityRepository.js';

// last_seen_at is written at most once per minute so reads do not each cost a write.
const LAST_SEEN_UPDATE_INTERVAL_SECONDS = 60;

export interface ActiveSession {
  user: User;
  tokenHash: string;
  authMethod: SessionAuthMethod;
  mustChangePassword: boolean;
}

export async function createSession(
  connection: Connection,
  session: { userId: string; authMethod: SessionAuthMethod; absoluteSeconds: number },
): Promise<string> {
  const token = randomSecret();
  await connection.query('DELETE FROM sessions WHERE expires_at<=now()');
  await connection.query(
    `INSERT INTO sessions(token_hash,user_id,auth_method,expires_at)
    VALUES($1,$2,$3,now()+make_interval(secs=>$4))`,
    [hashSecret(token), session.userId, session.authMethod, session.absoluteSeconds],
  );
  return token;
}

// A session is usable while it is unrevoked, within its absolute and idle limits, and its user is active.
export async function findActiveSession(
  connection: Connection,
  token: string,
  idleSeconds: number,
): Promise<ActiveSession | undefined> {
  const tokenHash = hashSecret(token);
  const session = await first<
    User & { authMethod: SessionAuthMethod; mustChangePassword: boolean; isLastSeenStale: boolean }
  >(
    connection,
    `SELECT ${userColumns},s.auth_method,
      (s.auth_method='local' AND COALESCE(c.must_change_password,false)) AS must_change_password,
      s.last_seen_at<now()-make_interval(secs=>$3) AS is_last_seen_stale
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN user_local_credentials c ON c.user_id=u.id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
    AND s.last_seen_at>now()-make_interval(secs=>$2) AND u.status='active'`,
    [tokenHash, idleSeconds, LAST_SEEN_UPDATE_INTERVAL_SECONDS],
  );
  if (!session) return undefined;
  const { authMethod, mustChangePassword, isLastSeenStale, ...user } = session;
  if (isLastSeenStale)
    await connection.query('UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1', [
      tokenHash,
    ]);
  return { user, tokenHash, authMethod, mustChangePassword };
}

export async function revokeSession(connection: Connection, token: string): Promise<void> {
  await connection.query(
    'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
    [hashSecret(token)],
  );
}

export async function revokeOtherSessions(
  connection: Connection,
  session: { userId: string; keepTokenHash: string },
): Promise<void> {
  await connection.query(
    'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL',
    [session.userId, session.keepTokenHash],
  );
}
