import * as oidc from 'openid-client';
import type { User } from '@mmt/contracts';
import type { ApiConfig } from '../config.js';
import { first, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import { sessionUser, tokenIdentity, upsertIdentity } from '../repositories/identityRepository.js';
import type { Principal } from '../auth/principal.js';

// Short login lifetime bounds replay exposure; sessions expire without sliding renewal.
export const LOGIN_LIFETIME_SECONDS = 10 * 60;
export const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

export class AuthService {
  private provider: Promise<oidc.Configuration> | undefined;
  constructor(
    private readonly database: Database,
    readonly config: ApiConfig,
  ) {}

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
    const user = await sessionUser(this.database, hashSecret(credentials.session));
    return user ? { user, method: 'session', token: null } : null;
  }

  async developmentLogin(identity: {
    email: string;
    displayName?: string;
  }): Promise<{ user: User; session: string }> {
    if (this.config.authMode !== 'development')
      throw new DomainError(404, 'Development loginは無効です', 'development_login_disabled');
    const email = identity.email.toLowerCase();
    const user = await upsertIdentity(this.database, {
      issuer: 'development',
      subject: email,
      email,
      displayName: identity.displayName ?? email,
      isAdmin: email === this.config.developmentAdminEmail,
    });
    return { user, session: await this.createSession(user.id) };
  }

  async beginLogin(): Promise<{ url: string; binding: string }> {
    if (this.config.authMode !== 'oidc')
      throw new DomainError(404, 'OIDC loginは無効です', 'oidc_disabled');
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
  ): Promise<{ user: User; session: string }> {
    if (this.config.authMode !== 'oidc')
      throw new DomainError(404, 'OIDC loginは無効です', 'oidc_disabled');
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
    let identity: Parameters<typeof upsertIdentity>[1];
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
      const groups = Array.isArray(claims.groups) ? claims.groups : [];
      identity = {
        issuer: this.config.oidc!.issuer,
        subject: claims.sub,
        email: claims.email,
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
    const user = await upsertIdentity(this.database, identity);
    return { user, session: await this.createSession(user.id) };
  }

  async logout(session: string | undefined): Promise<void> {
    if (session)
      await this.database.query('DELETE FROM sessions WHERE token_hash=$1', [hashSecret(session)]);
  }

  private async createSession(userId: string): Promise<string> {
    const session = randomSecret();
    await this.database.query('DELETE FROM sessions WHERE expires_at<=now()');
    await this.database.query(
      'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+make_interval(secs=>$3))',
      [hashSecret(session), userId, SESSION_LIFETIME_SECONDS],
    );
    return session;
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
