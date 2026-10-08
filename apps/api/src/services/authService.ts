import * as oidc from 'openid-client';
import type { User } from '@mmt/contracts';
import type { ApiConfig } from '../config.js';
import { first, transaction, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import {
  tokenIdentity,
  upsertIdentity,
  upsertOidcUser,
  type OidcLoginIdentity,
} from '../repositories/identityRepository.js';
import {
  createSession,
  findActiveSession,
  revokeSession,
} from '../repositories/sessionRepository.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import type { Principal } from '../auth/principal.js';
import { AuthRateLimiter, OIDC_START_IP_LIMIT } from '../auth/authRateLimiter.js';
import { argon2idPasswordHasher } from '../auth/passwordHasher.js';
import { loginAudit } from '../auth/authAuditEvents.js';
import { LocalAuthService } from './localAuthService.js';

// Short login lifetime bounds replay exposure of an unfinished OIDC login.
export const LOGIN_LIFETIME_SECONDS = 10 * 60;

export interface SessionLogin {
  user: User;
  session: string;
}

export class AuthService {
  private provider: Promise<oidc.Configuration> | undefined;
  // One limiter per process: local login, OIDC start, and password checks share its buckets.
  private readonly rateLimiter = new AuthRateLimiter();
  readonly local: LocalAuthService;
  constructor(
    private readonly database: Database,
    readonly config: ApiConfig,
  ) {
    this.local = new LocalAuthService({
      database,
      config,
      rateLimiter: this.rateLimiter,
      passwordHasher: argon2idPasswordHasher,
    });
  }

  async authenticate(credentials: {
    bearer?: string;
    session?: string;
  }): Promise<Principal | null> {
    if (credentials.bearer) {
      const identity = await tokenIdentity(this.database, hashSecret(credentials.bearer));
      if (!identity)
        throw new DomainError(401, 'API tokenが無効または失効しています', 'invalid_token');
      return { ...identity, method: 'token' };
    }
    if (!credentials.session) return null;
    const session = await findActiveSession(
      this.database,
      credentials.session,
      this.config.session.idleSeconds,
    );
    if (!session) return null;
    const { user, ...context } = session;
    return { user, method: 'session', token: null, session: context };
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
      scope: 'openid profile email',
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
    const login = await first<{ verifier: string; nonce: string }>(
      this.database,
      `DELETE FROM oidc_states WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>now() RETURNING verifier,nonce`,
      [hashSecret(state), hashSecret(binding)],
    );
    if (!login)
      throw new DomainError(401, 'Loginが失効したか、ブラウザが一致しません', 'invalid_oidc_state');
    const provider = await this.oidcProvider();
    let identity: OidcLoginIdentity;
    try {
      const tokens = await oidc.authorizationCodeGrant(provider, callbackUrl, {
        pkceCodeVerifier: login.verifier,
        expectedState: state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub || typeof claims.email !== 'string' || claims.email_verified !== true)
        throw new Error('Verified email is required');
      const groups = Array.isArray(claims.groups)
        ? claims.groups.filter((group): group is string => typeof group === 'string')
        : [];
      identity = {
        issuer: this.config.oidc!.issuer,
        subject: claims.sub,
        email: claims.email,
        emailVerified: true,
        groups,
        displayName: typeof claims.name === 'string' ? claims.name : claims.email,
        isAdmin: groups.includes(this.config.oidc!.adminGroup),
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
    return transaction(this.database, async (connection) => {
      const user = await upsertOidcUser(connection, identity);
      // Disabling is local to this app, so it overrides a still-valid SSO account.
      if (user.status !== 'active')
        throw new DomainError(401, 'OIDC認証に失敗しました', 'oidc_authentication_failed');
      const session = await createSession(connection, {
        userId: user.id,
        authMethod: 'oidc',
        absoluteSeconds: this.config.session.absoluteSeconds,
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
