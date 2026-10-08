import type { User } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import type { SessionAuthMethod } from '../auth/principal.js';
import type { EncryptedSecret } from '../security/secretEncryption.js';
import { userColumns } from './identityRepository.js';

// last_seen_at is written at most once per minute so reads do not each cost a write.
const LAST_SEEN_UPDATE_INTERVAL_SECONDS = 60;

export interface ActiveSession {
  user: User;
  tokenHash: string;
  authMethod: SessionAuthMethod;
  mustChangePassword: boolean;
  // When the IdP last confirmed an SSO session; null for other sessions and tokenless SSO sessions.
  oidcCheckedAt: Date | null;
  tokenExpiresAt: Date | null;
}

// The IdP tokens an SSO session holds, each encrypted with the same session encryption key.
export interface EncryptedSessionTokens {
  keyId: string;
  accessToken: Buffer;
  refreshToken: Buffer | null;
  expiresAt: Date | null;
}

export interface OidcSessionBinding {
  issuer: string;
  subject: string;
  sid: string | null;
}

// What a session recheck reads: the identity to ask UserInfo about and the tokens to ask with.
export interface OidcSessionState {
  tokenHash: string;
  userId: string;
  issuer: string | null;
  subject: string | null;
  tokens: EncryptedSessionTokens | null;
  checkedAt: Date | null;
}

// Clears the stored IdP tokens together with revoking, so a revoked session keeps no credential.
const REVOKE_SET =
  'revoked_at=now(),token_key_id=NULL,access_token_enc=NULL,refresh_token_enc=NULL';

// Rows arrive with timestamps as ISO strings (see mapColumns); the recheck compares Dates.
function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

// The token is chosen before the row exists, so callers can bind encrypted data to its hash.
export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomSecret();
  return { token, tokenHash: hashSecret(token) };
}

export async function createSession(
  connection: Connection,
  session: {
    userId: string;
    authMethod: SessionAuthMethod;
    absoluteSeconds: number;
    token?: { token: string; tokenHash: string };
    oidc?: { binding: OidcSessionBinding; tokens: EncryptedSessionTokens; checkedAt: Date };
  },
): Promise<string> {
  const { token, tokenHash } = session.token ?? newSessionToken();
  const oidc = session.oidc;
  await connection.query('DELETE FROM sessions WHERE expires_at<=now()');
  await connection.query(
    `INSERT INTO sessions(token_hash,user_id,auth_method,expires_at,
      oidc_issuer,oidc_subject,oidc_sid,token_key_id,access_token_enc,refresh_token_enc,
      token_expires_at,oidc_checked_at)
    VALUES($1,$2,$3,now()+make_interval(secs=>$4),$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      tokenHash,
      session.userId,
      session.authMethod,
      session.absoluteSeconds,
      oidc?.binding.issuer ?? null,
      oidc?.binding.subject ?? null,
      oidc?.binding.sid ?? null,
      oidc?.tokens.keyId ?? null,
      oidc?.tokens.accessToken ?? null,
      oidc?.tokens.refreshToken ?? null,
      oidc?.tokens.expiresAt ?? null,
      oidc?.checkedAt ?? null,
    ],
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
    User & {
      authMethod: SessionAuthMethod;
      mustChangePassword: boolean;
      isLastSeenStale: boolean;
      oidcCheckedAt: string | null;
      tokenExpiresAt: string | null;
    }
  >(
    connection,
    `SELECT ${userColumns},s.auth_method,s.oidc_checked_at,s.token_expires_at,
      (s.auth_method='local' AND COALESCE(c.must_change_password,false)) AS must_change_password,
      s.last_seen_at<now()-make_interval(secs=>$3) AS is_last_seen_stale
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN user_local_credentials c ON c.user_id=u.id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
    AND s.last_seen_at>now()-make_interval(secs=>$2) AND u.status='active'`,
    [tokenHash, idleSeconds, LAST_SEEN_UPDATE_INTERVAL_SECONDS],
  );
  if (!session) return undefined;
  const {
    authMethod,
    mustChangePassword,
    isLastSeenStale,
    oidcCheckedAt,
    tokenExpiresAt,
    ...user
  } = session;
  if (isLastSeenStale)
    await connection.query('UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1', [
      tokenHash,
    ]);
  return {
    user,
    tokenHash,
    authMethod,
    mustChangePassword,
    oidcCheckedAt: toDate(oidcCheckedAt),
    tokenExpiresAt: toDate(tokenExpiresAt),
  };
}

// Read again just before asking the IdP, so a check that waited uses tokens another check renewed.
export async function findOidcSessionState(
  connection: Connection,
  tokenHash: string,
): Promise<OidcSessionState | undefined> {
  const state = await first<{
    userId: string;
    oidcIssuer: string | null;
    oidcSubject: string | null;
    tokenKeyId: string | null;
    accessTokenEnc: Buffer | null;
    refreshTokenEnc: Buffer | null;
    tokenExpiresAt: string | null;
    oidcCheckedAt: string | null;
  }>(
    connection,
    `SELECT user_id,oidc_issuer,oidc_subject,token_key_id,access_token_enc,refresh_token_enc,
      token_expires_at,oidc_checked_at
    FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`,
    [tokenHash],
  );
  if (!state) return undefined;
  return {
    tokenHash,
    userId: state.userId,
    issuer: state.oidcIssuer,
    subject: state.oidcSubject,
    tokens:
      state.tokenKeyId && state.accessTokenEnc
        ? {
            keyId: state.tokenKeyId,
            accessToken: state.accessTokenEnc,
            refreshToken: state.refreshTokenEnc,
            expiresAt: toDate(state.tokenExpiresAt),
          }
        : null,
    checkedAt: toDate(state.oidcCheckedAt),
  };
}

/**
 * Stores the result of a successful recheck. The previous check time acts as a version: if
 * another check already replaced the tokens, this one is dropped and returns false, which keeps
 * a refresh token that the IdP rotated from being overwritten by an older one.
 */
export async function recordOidcSessionCheck(
  connection: Connection,
  check: {
    tokenHash: string;
    previousCheckedAt: Date | null;
    tokens: EncryptedSessionTokens;
    checkedAt: Date;
  },
): Promise<boolean> {
  const updated = await connection.query(
    `UPDATE sessions SET oidc_checked_at=$3,token_key_id=$4,access_token_enc=$5,
      refresh_token_enc=$6,token_expires_at=$7
    WHERE token_hash=$1 AND revoked_at IS NULL AND oidc_checked_at IS NOT DISTINCT FROM $2`,
    [
      check.tokenHash,
      check.previousCheckedAt,
      check.checkedAt,
      check.tokens.keyId,
      check.tokens.accessToken,
      check.tokens.refreshToken,
      check.tokens.expiresAt,
    ],
  );
  return updated.rowCount === 1;
}

export async function revokeSession(connection: Connection, token: string): Promise<void> {
  await revokeSessionByHash(connection, hashSecret(token));
}

export async function revokeSessionByHash(
  connection: Connection,
  tokenHash: string,
): Promise<void> {
  await connection.query(
    `UPDATE sessions SET ${REVOKE_SET} WHERE token_hash=$1 AND revoked_at IS NULL`,
    [tokenHash],
  );
}

// Every browser session of the SSO identity: a group removal, or a back-channel logout by sub.
export async function revokeOidcIdentitySessions(
  connection: Connection,
  identity: { issuer: string; subject: string },
): Promise<number> {
  const revoked = await connection.query(
    `UPDATE sessions SET ${REVOKE_SET}
    WHERE oidc_issuer=$1 AND oidc_subject=$2 AND revoked_at IS NULL`,
    [identity.issuer, identity.subject],
  );
  return revoked.rowCount ?? 0;
}

// Back-channel logout by IdP session id; the subject narrows it when the logout token names one.
export async function revokeOidcSidSessions(
  connection: Connection,
  logout: { issuer: string; sid: string; subject: string | null },
): Promise<number> {
  const revoked = await connection.query(
    `UPDATE sessions SET ${REVOKE_SET}
    WHERE oidc_issuer=$1 AND oidc_sid=$2 AND ($3::text IS NULL OR oidc_subject=$3)
    AND revoked_at IS NULL`,
    [logout.issuer, logout.sid, logout.subject],
  );
  return revoked.rowCount ?? 0;
}

export async function revokeOtherSessions(
  connection: Connection,
  session: { userId: string; keepTokenHash: string },
): Promise<void> {
  await connection.query(
    `UPDATE sessions SET ${REVOKE_SET} WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL`,
    [session.userId, session.keepTokenHash],
  );
}

// Used when an administrator disables a user or resets their password: every session ends now.
export async function revokeAllForUser(connection: Connection, userId: string): Promise<void> {
  await connection.query(
    `UPDATE sessions SET ${REVOKE_SET} WHERE user_id=$1 AND revoked_at IS NULL`,
    [userId],
  );
}

// Records a back-channel logout token's jti; false when the same token was accepted before.
export async function consumeLogoutTokenId(
  connection: Connection,
  logout: { issuer: string; jti: string; now: Date; expiresAt: Date },
): Promise<boolean> {
  await connection.query('DELETE FROM oidc_logout_tokens WHERE expires_at<=$1', [logout.now]);
  const inserted = await connection.query(
    `INSERT INTO oidc_logout_tokens(issuer,jti,expires_at) VALUES($1,$2,$3)
    ON CONFLICT(issuer,jti) DO NOTHING`,
    [logout.issuer, logout.jti, logout.expiresAt],
  );
  return inserted.rowCount === 1;
}
