import * as oidc from 'openid-client';
import type { ApiConfig } from '../config.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { findUser, withdrawOidcIdentityAccess } from '../repositories/identityRepository.js';
import {
  findOidcSessionState,
  recordOidcSessionCheck,
  revokeOidcIdentitySessions,
  revokeSessionByHash,
  type ActiveSession,
  type EncryptedSessionTokens,
  type OidcSessionState,
} from '../repositories/sessionRepository.js';
import { decryptSecret, encryptSecret, type SecretKey } from '../security/secretEncryption.js';
import { OidcLoginDeniedError, syncOidcIdentity, type OidcClaims } from './oidcProvisioning.js';

/**
 * Keeps SSO browser sessions in step with the IdP. A session whose last check is older than
 * OIDC_RECHECK_SECONDS, or whose access token expired, asks UserInfo for the current groups
 * (refreshing the access token when needed) and applies them like a login does. Losing the
 * allowed group ends every session of the identity; an IdP that refuses the tokens ends this
 * session; an IdP that cannot be reached answers 503 and keeps the session (fail closed).
 * Same design as Mado's auth-oidc-session.ts.
 */

// Renew a little before the IdP's deadline so the token does not expire during the UserInfo call.
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

export interface SessionTokens {
  accessToken: string;
  // Absent when the IdP does not issue refresh tokens (no offline_access); the session then ends
  // when the access token expires.
  refreshToken: string | null;
  expiresAt: Date | null;
}

// Why a session ended at recheck; recorded in the auth.oidc.recheck audit event.
export type OidcRecheckRevocationReason =
  'reauthentication_required' | 'idp_session_revoked' | OidcLoginDeniedError['reason'];

// The context binds each ciphertext to its session row and token kind, so a copied value fails.
function tokenContext(tokenHash: string, kind: 'access' | 'refresh'): string {
  return `oidc-session:${tokenHash}:${kind}`;
}

export function encryptSessionTokens({
  key,
  tokenHash,
  tokens,
}: {
  key: SecretKey;
  tokenHash: string;
  tokens: SessionTokens;
}): EncryptedSessionTokens {
  const encrypt = (plaintext: string, kind: 'access' | 'refresh') =>
    encryptSecret({ key, plaintext, context: tokenContext(tokenHash, kind) }).payload;
  return {
    keyId: key.id,
    accessToken: encrypt(tokens.accessToken, 'access'),
    refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken, 'refresh') : null,
    expiresAt: tokens.expiresAt,
  };
}

export function decryptSessionTokens({
  key,
  tokenHash,
  encrypted,
}: {
  key: SecretKey;
  tokenHash: string;
  encrypted: EncryptedSessionTokens;
}): SessionTokens {
  const decrypt = (payload: Buffer, kind: 'access' | 'refresh') =>
    decryptSecret({
      key,
      encrypted: { keyId: encrypted.keyId, payload },
      context: tokenContext(tokenHash, kind),
    });
  return {
    accessToken: decrypt(encrypted.accessToken, 'access'),
    refreshToken: encrypted.refreshToken ? decrypt(encrypted.refreshToken, 'refresh') : null,
    expiresAt: encrypted.expiresAt,
  };
}

// A refresh response may omit refresh_token, which means the previous one stays valid.
export function sessionTokensFromResponse(
  response: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
  { now, previousRefreshToken }: { now: Date; previousRefreshToken: string | null },
): SessionTokens {
  const expiresIn = response.expiresIn();
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previousRefreshToken,
    expiresAt: expiresIn === undefined ? null : new Date(now.getTime() + expiresIn * 1000),
  };
}

// The IdP answered and refused the tokens: the user signed out there, or the grant was revoked.
function isRefusedByIdentityProvider(error: unknown): boolean {
  if (error instanceof oidc.WWWAuthenticateChallengeError) return error.status === 401;
  if (error instanceof oidc.ResponseBodyError)
    return (
      error.error === 'invalid_grant' ||
      error.error === 'invalid_token' ||
      (error.status === 401 && error.error !== 'invalid_client')
    );
  return false;
}

class ReauthenticationRequiredError extends Error {
  constructor() {
    super('The SSO session has no usable tokens');
    this.name = 'ReauthenticationRequiredError';
  }
}

// A session whose identity and tokens are all present, so the IdP can be asked about it.
type CheckableSession = OidcSessionState & {
  issuer: string;
  subject: string;
  tokens: EncryptedSessionTokens;
};

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export interface OidcSessionVerifierOptions {
  database: Database;
  settings: NonNullable<ApiConfig['oidc']>;
  provider: () => Promise<oidc.Configuration>;
  clock: () => Date;
}

// current: no check was due. rechecked: the IdP confirmed it now, and the user's groups and
// global role may have changed. revoked: the session must not be used any more.
export type OidcSessionVerdict = 'current' | 'rechecked' | 'revoked';

export class OidcSessionVerifier {
  // One check per session at a time; concurrent requests of the session wait for the same result.
  private readonly checksInFlight = new Map<string, Promise<OidcSessionVerdict>>();

  constructor(private readonly options: OidcSessionVerifierOptions) {}

  async verify(session: ActiveSession): Promise<OidcSessionVerdict> {
    if (session.authMethod !== 'oidc') return 'current';
    if (this.isCurrent(session.oidcCheckedAt, session.tokenExpiresAt)) return 'current';
    const running = this.checksInFlight.get(session.tokenHash);
    if (running) return running;
    const check = this.recheck(session.tokenHash).finally(() =>
      this.checksInFlight.delete(session.tokenHash),
    );
    this.checksInFlight.set(session.tokenHash, check);
    return check;
  }

  private isCurrent(checkedAt: Date | null, tokenExpiresAt: Date | null): boolean {
    const now = this.options.clock().getTime();
    return (
      checkedAt !== null &&
      now - checkedAt.getTime() < this.options.settings.recheckSeconds * 1000 &&
      !this.isExpired(tokenExpiresAt)
    );
  }

  private isExpired(expiresAt: Date | null): boolean {
    return (
      expiresAt !== null &&
      expiresAt.getTime() - TOKEN_EXPIRY_MARGIN_MS <= this.options.clock().getTime()
    );
  }

  private async recheck(tokenHash: string): Promise<OidcSessionVerdict> {
    const { database, settings } = this.options;
    const state = await findOidcSessionState(database, tokenHash);
    if (!state) return 'revoked';
    // Another process checked it while this request waited.
    if (state.tokens && this.isCurrent(state.checkedAt, state.tokens.expiresAt)) return 'rechecked';
    // Sessions from before migration 042 or from another issuer have nothing to check with.
    if (!state.tokens || !state.issuer || state.issuer !== settings.issuer || !state.subject)
      return this.endSession(state, 'reauthentication_required');
    const session: CheckableSession = {
      ...state,
      issuer: state.issuer,
      subject: state.subject,
      tokens: state.tokens,
    };
    let tokens: SessionTokens;
    try {
      tokens = decryptSessionTokens({
        key: settings.sessionEncryptionKey,
        tokenHash,
        encrypted: session.tokens,
      });
    } catch {
      // Encrypted with a key that has since been replaced: only a new login can continue.
      return this.endSession(state, 'reauthentication_required');
    }
    const provider = await this.options.provider();
    let current: { claims: oidc.UserInfoResponse; tokens: SessionTokens };
    try {
      current = await this.askIdentityProvider(provider, session.subject, tokens);
    } catch (error) {
      if (error instanceof ReauthenticationRequiredError)
        return this.endSession(session, 'reauthentication_required');
      if (isRefusedByIdentityProvider(error))
        return this.endSession(session, 'idp_session_revoked');
      // Provider responses may contain tokens, so only the error's kind is logged.
      console.error(
        JSON.stringify({
          event: 'oidc_session_check_failed',
          name: error instanceof Error ? error.name : 'Error',
          code: (error as { code?: unknown }).code ?? null,
        }),
      );
      throw new DomainError(
        503,
        'SSOのログイン状態を確認できません。しばらくしてから再度お試しください',
        'oidc_unavailable',
      );
    }
    return this.applyCurrentClaims(session, current);
  }

  private async askIdentityProvider(
    provider: oidc.Configuration,
    subject: string,
    tokens: SessionTokens,
  ): Promise<{ claims: oidc.UserInfoResponse; tokens: SessionTokens }> {
    let current = tokens;
    let refreshed = false;
    if (this.isExpired(current.expiresAt)) {
      current = await this.refresh(provider, current);
      refreshed = true;
    }
    try {
      return {
        claims: await oidc.fetchUserInfo(provider, current.accessToken, subject),
        tokens: current,
      };
    } catch (error) {
      // The IdP may stop accepting an access token before its stated expiry; renew it once.
      if (refreshed || !current.refreshToken || !isRefusedByIdentityProvider(error)) throw error;
      current = await this.refresh(provider, current);
      return {
        claims: await oidc.fetchUserInfo(provider, current.accessToken, subject),
        tokens: current,
      };
    }
  }

  private async refresh(
    provider: oidc.Configuration,
    tokens: SessionTokens,
  ): Promise<SessionTokens> {
    if (!tokens.refreshToken) throw new ReauthenticationRequiredError();
    const response = await oidc.refreshTokenGrant(provider, tokens.refreshToken);
    return sessionTokensFromResponse(response, {
      now: this.options.clock(),
      previousRefreshToken: tokens.refreshToken,
    });
  }

  private async applyCurrentClaims(
    state: CheckableSession,
    current: { claims: oidc.UserInfoResponse; tokens: SessionTokens },
  ): Promise<OidcSessionVerdict> {
    const { database, settings } = this.options;
    const user = await findUser(database, state.userId);
    if (!user) return 'revoked';
    const verifiedEmail =
      current.claims.email_verified === true ? stringClaim(current.claims.email) : undefined;
    const claims: OidcClaims = {
      issuer: settings.issuer,
      subject: state.subject,
      // UserInfo may leave out profile claims; the stored ones stay.
      // An unverified email is never stored.
      email: verifiedEmail ?? user.email,
      emailVerified: true,
      displayName: stringClaim(current.claims.name) ?? user.displayName,
      groups: Array.isArray(current.claims.groups) ? current.claims.groups : [],
    };
    try {
      const recorded = await transaction(database, async (connection) => {
        await syncOidcIdentity(connection, {
          userId: state.userId,
          claims,
          rolePolicy: settings.rolePolicy,
        });
        return recordOidcSessionCheck(connection, {
          tokenHash: state.tokenHash,
          previousCheckedAt: state.checkedAt,
          tokens: encryptSessionTokens({
            key: settings.sessionEncryptionKey,
            tokenHash: state.tokenHash,
            tokens: current.tokens,
          }),
          checkedAt: this.options.clock(),
        });
      });
      if (recorded) return 'rechecked';
      // Another check stored newer tokens first, or the session ended meanwhile.
      return (await findOidcSessionState(database, state.tokenHash)) ? 'rechecked' : 'revoked';
    } catch (error) {
      if (!(error instanceof OidcLoginDeniedError)) throw error;
      return this.withdrawIdentity(state, error);
    }
  }

  // The identity may no longer use the app: every session of it ends and its groups are removed.
  private async withdrawIdentity(
    state: CheckableSession,
    denial: OidcLoginDeniedError,
  ): Promise<'revoked'> {
    await transaction(this.options.database, async (connection) => {
      const identity = { issuer: state.issuer, subject: state.subject, userId: state.userId };
      const revokedSessions = await revokeOidcIdentitySessions(connection, identity);
      await withdrawOidcIdentityAccess(connection, identity);
      await this.recordRevocation(connection, state, {
        reason: denial.reason,
        scope: 'identity',
        revokedSessions,
      });
    });
    return 'revoked';
  }

  private async endSession(
    state: OidcSessionState,
    reason: OidcRecheckRevocationReason,
  ): Promise<'revoked'> {
    await transaction(this.options.database, async (connection) => {
      await revokeSessionByHash(connection, state.tokenHash);
      await this.recordRevocation(connection, state, {
        reason,
        scope: 'session',
        revokedSessions: 1,
      });
    });
    return 'revoked';
  }

  private async recordRevocation(
    connection: Parameters<typeof writeAuditEvent>[0],
    state: OidcSessionState,
    revocation: {
      reason: OidcRecheckRevocationReason;
      scope: 'session' | 'identity';
      revokedSessions: number;
    },
  ): Promise<void> {
    console.error(
      JSON.stringify({ event: 'oidc_session_revoked', userId: state.userId, ...revocation }),
    );
    await writeAuditEvent(connection, {
      actorType: 'system',
      action: 'auth.oidc.recheck',
      outcome: 'denied',
      resourceType: 'user',
      resourceId: state.userId,
      details: { ...revocation, subject: state.subject },
    });
  }
}
