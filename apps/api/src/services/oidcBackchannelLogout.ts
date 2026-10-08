import * as oidc from 'openid-client';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import type { ApiConfig } from '../config.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  consumeLogoutTokenId,
  revokeOidcIdentitySessions,
  revokeOidcSidSessions,
} from '../repositories/sessionRepository.js';

/**
 * OpenID Connect Back-Channel Logout 1.0: the IdP posts a signed logout token when a user signs
 * out there or is disabled, and the matching browser sessions end here. Same checks as Mado.
 */

const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
// The IdP sends the token right after the logout; an older one is treated as captured and replayed.
const LOGOUT_TOKEN_MAX_AGE_SECONDS = 10 * 60;
// Tolerates a small clock difference between the IdP and this server.
const LOGOUT_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;
// The jti store needs a row only while the token would still pass the age check.
const LOGOUT_TOKEN_ID_RETENTION_SECONDS =
  LOGOUT_TOKEN_MAX_AGE_SECONDS + LOGOUT_TOKEN_CLOCK_TOLERANCE_SECONDS;
const MAX_LOGOUT_TOKEN_ID_LENGTH = 512;

export interface LogoutTokenClaims {
  jti: string;
  subject: string | null;
  sid: string | null;
}

function invalidLogoutToken(): DomainError {
  return new DomainError(400, 'logout tokenが不正です', 'invalid_logout_token');
}

// jwtVerify checks the signature, iss, aud and iat; this checks what makes it a logout token.
export function logoutTokenClaims(payload: JWTPayload): LogoutTokenClaims {
  const events = payload.events;
  if (
    !events ||
    typeof events !== 'object' ||
    Array.isArray(events) ||
    typeof (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT] !== 'object' ||
    // A nonce would make it an ID token; the spec forbids it so one cannot pass for the other.
    payload.nonce !== undefined
  )
    throw invalidLogoutToken();
  const subject = typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  const sid = typeof payload.sid === 'string' && payload.sid ? payload.sid : null;
  if (!subject && !sid) throw invalidLogoutToken();
  if (
    typeof payload.jti !== 'string' ||
    payload.jti === '' ||
    payload.jti.length > MAX_LOGOUT_TOKEN_ID_LENGTH
  )
    throw invalidLogoutToken();
  return { jti: payload.jti, subject, sid };
}

export class OidcBackchannelLogout {
  private signingKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(
    private readonly options: {
      database: Database;
      settings: NonNullable<ApiConfig['oidc']>;
      provider: () => Promise<oidc.Configuration>;
      clock: () => Date;
    },
  ) {}

  async logout(logoutToken: string, metadata: RequestMetadata): Promise<void> {
    const { issuer, claims } = await this.verify(logoutToken);
    await transaction(this.options.database, async (connection) => {
      const now = this.options.clock();
      const accepted = await consumeLogoutTokenId(connection, {
        issuer,
        jti: claims.jti,
        now,
        expiresAt: new Date(now.getTime() + LOGOUT_TOKEN_ID_RETENTION_SECONDS * 1000),
      });
      if (!accepted)
        throw new DomainError(400, 'このlogout tokenは使用済みです', 'logout_token_replayed');
      const revokedSessions = claims.sid
        ? await revokeOidcSidSessions(connection, {
            issuer,
            sid: claims.sid,
            subject: claims.subject,
          })
        : await revokeOidcIdentitySessions(connection, { issuer, subject: claims.subject! });
      await writeAuditEvent(connection, {
        actorType: 'system',
        action: 'auth.oidc.backchannel_logout',
        outcome: 'success',
        resourceType: 'oidc_identity',
        details: { subject: claims.subject, sid: claims.sid, revokedSessions },
        ...metadata,
      });
    });
  }

  private async verify(
    logoutToken: string,
  ): Promise<{ issuer: string; claims: LogoutTokenClaims }> {
    const { settings, clock } = this.options;
    const server = (await this.options.provider()).serverMetadata();
    if (!server.jwks_uri)
      throw new DomainError(503, 'OIDC providerの署名鍵を取得できません', 'oidc_unavailable');
    this.signingKeys ??= createRemoteJWKSet(new URL(server.jwks_uri));
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(logoutToken, this.signingKeys, {
        issuer: server.issuer,
        audience: settings.clientId,
        requiredClaims: ['iat', 'jti', 'events'],
        maxTokenAge: LOGOUT_TOKEN_MAX_AGE_SECONDS,
        clockTolerance: LOGOUT_TOKEN_CLOCK_TOLERANCE_SECONDS,
        currentDate: clock(),
      }));
    } catch (error) {
      // Failing to fetch the keys says nothing about the token; the IdP retries on a 5xx.
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError))
        throw new DomainError(503, 'OIDC providerの署名鍵を取得できません', 'oidc_unavailable');
      throw invalidLogoutToken();
    }
    // Sessions store the configured issuer, which discovery has confirmed equals server.issuer.
    return { issuer: settings.issuer, claims: logoutTokenClaims(payload) };
  }
}
