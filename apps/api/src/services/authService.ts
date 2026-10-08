import * as oidc from 'openid-client';
import type { User } from '@mmt/contracts';
import type { ApiConfig } from '../config.js';
import { first, transaction, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import {
  recordLogin,
  tokenIdentity,
  upsertIdentity,
  withdrawOidcIdentityAccess,
} from '../repositories/identityRepository.js';
import {
  createSession,
  findActiveSession,
  newSessionToken,
  revokeOidcIdentitySessions,
  revokeSession,
} from '../repositories/sessionRepository.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import type { Principal } from '../auth/principal.js';
import { AuthRateLimiter, OIDC_START_IP_LIMIT } from '../auth/authRateLimiter.js';
import { argon2idPasswordHasher } from '../auth/passwordHasher.js';
import { loginAudit } from '../auth/authAuditEvents.js';
import { LocalAuthService } from './localAuthService.js';
import { OidcLoginDeniedError, provisionOidcLogin, type OidcClaims } from './oidcProvisioning.js';
import {
  encryptSessionTokens,
  OidcSessionVerifier,
  sessionTokensFromResponse,
  type SessionTokens,
} from './oidcSessionVerifier.js';
import { OidcBackchannelLogout } from './oidcBackchannelLogout.js';

// Short login lifetime bounds replay exposure of an unfinished OIDC login.
export const LOGIN_LIFETIME_SECONDS = 10 * 60;

export interface SessionLogin {
  user: User;
  session: string;
}

// What the code exchange yields besides the claims: the tokens the session keeps for rechecks.
interface OidcLoginResult {
  claims: OidcClaims;
  tokens: SessionTokens;
  sid: string | null;
}

export interface AuthServiceOptions {
  // Tests move it forward to pass the recheck interval and token lifetimes without waiting.
  clock?: () => Date;
}

export class AuthService {
  private provider: Promise<oidc.Configuration> | undefined;
  // One limiter per process: local login, OIDC start, and password checks share its buckets.
  private readonly rateLimiter = new AuthRateLimiter();
  readonly local: LocalAuthService;
  private readonly clock: () => Date;
  // Null when OIDC is off; then no session has IdP tokens and nothing is rechecked.
  private readonly sessionVerifier: OidcSessionVerifier | null;
  private readonly backchannel: OidcBackchannelLogout | null;
  constructor(
    private readonly database: Database,
    readonly config: ApiConfig,
    options: AuthServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.local = new LocalAuthService({
      database,
      config,
      rateLimiter: this.rateLimiter,
      passwordHasher: argon2idPasswordHasher,
    });
    const provider = () => this.oidcProvider();
    this.sessionVerifier = config.oidc
      ? new OidcSessionVerifier({ database, settings: config.oidc, provider, clock: this.clock })
      : null;
    this.backchannel = config.oidc
      ? new OidcBackchannelLogout({ database, settings: config.oidc, provider, clock: this.clock })
      : null;
  }

  async authenticate(credentials: {
    bearer?: string;
    session?: string;
  }): Promise<Principal | null> {
    if (credentials.bearer) return this.authenticateApiToken(credentials.bearer);
    if (!credentials.session) return null;
    const session = await findActiveSession(
      this.database,
      credentials.session,
      this.config.session.idleSeconds,
    );
    if (!session) return null;
    // An SSO session without OIDC configured cannot be confirmed, so it is not accepted.
    if (session.authMethod === 'oidc' && !this.sessionVerifier) return null;
    const verdict = this.sessionVerifier ? await this.sessionVerifier.verify(session) : 'current';
    if (verdict === 'revoked') return null;
    // The recheck may have changed the user's global role, so the user is read again.
    const current =
      verdict === 'rechecked'
        ? await findActiveSession(
            this.database,
            credentials.session,
            this.config.session.idleSeconds,
          )
        : session;
    if (!current) return null;
    const { user, tokenHash, authMethod, mustChangePassword } = current;
    return {
      user,
      method: 'session',
      token: null,
      session: { tokenHash, authMethod, mustChangePassword },
    };
  }

  private async authenticateApiToken(bearer: string): Promise<Principal> {
    const syncedAfter = new Date(
      this.clock().getTime() - this.config.oidcTokenSyncMaxAgeSeconds * 1000,
    );
    const identity = await tokenIdentity(this.database, {
      tokenHash: hashSecret(bearer),
      syncedAfter,
    });
    if (!identity)
      throw new DomainError(401, 'API tokenが無効または失効しています', 'invalid_token');
    if (identity.isIdentitySyncStale)
      throw new DomainError(
        401,
        'SSOのgroupが長く確認されていないため、このtokenは止まっています。ブラウザで一度ログインしてください',
        'identity_sync_required',
      );
    return { user: identity.user, token: identity.token, method: 'token' };
  }

  async developmentLogin(
    identity: { email: string; displayName?: string },
    metadata: RequestMetadata,
  ): Promise<SessionLogin> {
    if (this.config.authMode !== 'development')
      throw new DomainError(404, 'Development loginは無効です', 'development_login_disabled');
    const email = identity.email.toLowerCase();
    return transaction(this.database, async (connection) => {
      const user = await upsertIdentity(connection, {
        issuer: 'development',
        subject: email,
        email,
        displayName: identity.displayName ?? email,
        isAdmin: email === this.config.developmentAdminEmail,
      });
      const session = await createSession(connection, {
        userId: user.id,
        authMethod: 'development',
        absoluteSeconds: this.config.session.absoluteSeconds,
      });
      await recordLogin(connection, user.id);
      await writeAuditEvent(connection, {
        ...loginAudit('development', metadata),
        actorType: 'user',
        actorUserId: user.id,
        outcome: 'success',
        resourceId: user.id,
      });
      return { user, session };
    });
  }

  async beginLogin(metadata: RequestMetadata): Promise<{ url: string; binding: string }> {
    if (!this.config.oidc) throw new DomainError(404, 'OIDC loginは無効です', 'oidc_disabled');
    this.rateLimiter.consumeOrThrow(
      `oidc-start:ip:${metadata.ip ?? 'unknown'}`,
      OIDC_START_IP_LIMIT,
    );
    const provider = await this.oidcProvider();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const binding = randomSecret();
    await this.database.query('DELETE FROM oidc_states WHERE expires_at<=now()');
    await this.database.query(
      `INSERT INTO oidc_states(state_hash,binding_hash,verifier,nonce,expires_at) VALUES($1,$2,$3,$4,now()+make_interval(secs=>$5))`,
      [hashSecret(state), hashSecret(binding), verifier, nonce, LOGIN_LIFETIME_SECONDS],
    );
    const url = oidc.buildAuthorizationUrl(provider, {
      redirect_uri: `${this.config.publicUrl}/api/auth/callback`,
      scope: this.config.oidc.scopes,
      response_type: 'code',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return { url: url.href, binding };
  }

  async finishLogin(
    callbackUrl: URL,
    binding: string | undefined,
    metadata: RequestMetadata,
  ): Promise<SessionLogin> {
    if (!this.config.oidc) throw new DomainError(404, 'OIDC loginは無効です', 'oidc_disabled');
    try {
      return await this.completeOidcLogin(callbackUrl, binding, metadata);
    } catch (error) {
      if (error instanceof DomainError && error.status === 401)
        await writeAuditEvent(this.database, {
          ...loginAudit('oidc', metadata),
          actorType: 'system',
          outcome: 'failed',
          details: { method: 'oidc', reason: error.code },
        });
      throw error;
    }
  }

  private async completeOidcLogin(
    callbackUrl: URL,
    binding: string | undefined,
    metadata: RequestMetadata,
  ): Promise<SessionLogin> {
    const state = callbackUrl.searchParams.get('state');
    if (!binding || !state || callbackUrl.searchParams.getAll('state').length !== 1)
      throw new DomainError(
        401,
        'Loginのブラウザまたはstateを確認できません',
        'invalid_oidc_state',
      );
    // Consuming the state is atomic. A mismatch cannot consume another browser's login.
    const pending = await first<{ verifier: string; nonce: string }>(
      this.database,
      `DELETE FROM oidc_states WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>now() RETURNING verifier,nonce`,
      [hashSecret(state), hashSecret(binding)],
    );
    if (!pending)
      throw new DomainError(401, 'Loginが失効したか、ブラウザが一致しません', 'invalid_oidc_state');
    const provider = await this.oidcProvider();
    let login: OidcLoginResult;
    try {
      const tokens = await oidc.authorizationCodeGrant(provider, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const idToken = tokens.claims();
      if (!idToken?.sub) throw new Error('Subject is required');
      const email = typeof idToken.email === 'string' ? idToken.email : '';
      login = {
        claims: {
          issuer: this.config.oidc!.issuer,
          subject: idToken.sub,
          email,
          // An unverified email is neither stored nor used for linking; provisioning refuses it.
          emailVerified: email !== '' && idToken.email_verified === true,
          displayName: typeof idToken.name === 'string' && idToken.name ? idToken.name : email,
          groups: Array.isArray(idToken.groups) ? idToken.groups : [],
        },
        tokens: sessionTokensFromResponse(tokens, {
          now: this.clock(),
          previousRefreshToken: null,
        }),
        sid: typeof idToken.sid === 'string' && idToken.sid ? idToken.sid : null,
      };
    } catch (error) {
      // Provider responses may contain codes or tokens, so never expose its exception.
      console.error(
        JSON.stringify({
          event: 'oidc_authentication_failed',
          name: error instanceof Error ? error.name : 'Error',
          code: error instanceof oidc.ClientError ? error.code : 'validation_failed',
        }),
      );
      throw new DomainError(401, 'OIDC認証に失敗しました', 'oidc_authentication_failed');
    }
    try {
      return await this.provisionSession(login, metadata);
    } catch (error) {
      if (!(error instanceof OidcLoginDeniedError)) throw error;
      await this.recordOidcDenial(error, login.claims, metadata);
      throw new DomainError(401, 'OIDC認証に失敗しました', 'oidc_authentication_failed');
    }
  }

  private async provisionSession(
    { claims, tokens, sid }: OidcLoginResult,
    metadata: RequestMetadata,
  ): Promise<SessionLogin> {
    const settings = this.config.oidc!;
    const sessionToken = newSessionToken();
    return transaction(this.database, async (connection) => {
      const user = await provisionOidcLogin(connection, {
        claims,
        policy: {
          rolePolicy: settings.rolePolicy,
          autoLinkVerifiedEmail: settings.autoLinkVerifiedEmail,
        },
        metadata,
      });
      const session = await createSession(connection, {
        userId: user.id,
        authMethod: 'oidc',
        absoluteSeconds: this.config.session.absoluteSeconds,
        token: sessionToken,
        oidc: {
          binding: { issuer: claims.issuer, subject: claims.subject, sid },
          tokens: encryptSessionTokens({
            key: settings.sessionEncryptionKey,
            tokenHash: sessionToken.tokenHash,
            tokens,
          }),
          checkedAt: this.clock(),
        },
      });
      await writeAuditEvent(connection, {
        ...loginAudit('oidc', metadata),
        actorType: 'user',
        actorUserId: user.id,
        outcome: 'success',
        resourceId: user.id,
      });
      return { user, session };
    });
  }

  // The provisioning transaction rolled back, so the denial is recorded on its own.
  // The audit row names the SSO account so operators can tell who was refused.
  // A known identity that the IdP no longer allows also loses its other sessions and groups,
  // the same as when a session recheck finds it removed from the allowed groups.
  private async recordOidcDenial(
    denial: OidcLoginDeniedError,
    claims: OidcClaims,
    metadata: RequestMetadata,
  ): Promise<void> {
    console.error(
      JSON.stringify({ event: 'oidc_login_denied', reason: denial.reason, userId: denial.userId }),
    );
    await transaction(this.database, async (connection) => {
      if (denial.reason === 'group_not_allowed' && denial.userId) {
        const identity = { issuer: claims.issuer, subject: claims.subject, userId: denial.userId };
        await revokeOidcIdentitySessions(connection, identity);
        await withdrawOidcIdentityAccess(connection, identity);
      }
      await writeAuditEvent(connection, {
        actorType: 'system',
        action: 'auth.oidc.denied',
        outcome: 'denied',
        resourceType: 'user',
        resourceId: denial.userId,
        details: { reason: denial.reason, subject: claims.subject, email: claims.email },
        ...metadata,
      });
    });
  }

  async backchannelLogout(logoutToken: string, metadata: RequestMetadata): Promise<void> {
    if (!this.backchannel) throw new DomainError(404, 'OIDC loginは無効です', 'oidc_disabled');
    await this.backchannel.logout(logoutToken, metadata);
  }

  async logout(
    principal: Principal | null,
    session: string | undefined,
    metadata: RequestMetadata,
  ): Promise<void> {
    if (!session) return;
    await transaction(this.database, async (connection) => {
      await revokeSession(connection, session);
      if (principal?.session)
        await writeAuditEvent(connection, {
          actorType: 'user',
          actorUserId: principal.user.id,
          action: 'auth.logout',
          outcome: 'success',
          resourceType: 'user',
          resourceId: principal.user.id,
          details: { method: principal.session.authMethod },
          ...metadata,
        });
    });
  }

  private async oidcProvider(): Promise<oidc.Configuration> {
    const settings = this.config.oidc;
    if (!settings) throw new DomainError(503, 'OIDCが設定されていません', 'oidc_unavailable');
    this.provider ??= oidc.discovery(
      new URL(settings.issuer),
      settings.clientId,
      settings.clientSecret,
      settings.clientSecret ? oidc.ClientSecretBasic(settings.clientSecret) : oidc.None(),
      {
        timeout: 10,
        execute: settings.allowInsecureHttp
          ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks]
          : [oidc.enableNonRepudiationChecks],
      },
    );
    try {
      return await this.provider;
    } catch {
      this.provider = undefined;
      throw new DomainError(503, 'OIDC providerに接続できません', 'oidc_unavailable');
    }
  }
}
