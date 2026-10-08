import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// base64 of 32 bytes for MMT_SESSION_ENCRYPTION_KEY, which oidc and hybrid configurations require.
export const TEST_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
// Authentik's default access token lifetime is 5 minutes.
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 300;

// Fields of a back-channel logout token; tests break one at a time to check the validation.
export interface MockLogoutToken {
  subject?: string;
  sid?: string;
  jti?: string;
  issuedAt?: Date;
  audience?: string;
  issuer?: string;
  events?: unknown;
  nonce?: string;
  signWithWrongKey?: boolean;
}

// ID token claims the provider returns. Tests swap them to act as different IdP accounts.
export interface MockOidcClaims {
  subject: string;
  email: string | undefined;
  emailVerified: boolean;
  name: string;
  groups: unknown[];
}

const DEFAULT_CLAIMS: MockOidcClaims = {
  subject: 'test-subject',
  email: 'oidc@example.test',
  emailVerified: true,
  name: 'OIDC Test User',
  groups: ['mmt-admins'],
};

export async function startMockOidcProvider() {
  const keyPair = await generateKeyPair('RS256', { extractable: true });
  const publicKey = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'mock-signing-key',
    alg: 'RS256',
    use: 'sig',
  };
  const authorizations = new Map<
    string,
    { nonce: string; challenge: string; redirectUri: string }
  >();
  let issuer = '';
  let shouldReturnWrongNonce = false;
  let shouldSignWithWrongKey = false;
  let tokenRequests = 0;
  let refreshRequests = 0;
  let userInfoRequests = 0;
  let claims: MockOidcClaims = { ...DEFAULT_CLAIMS };
  // Token value -> subject it was issued to. Removing an entry is how the IdP revokes it.
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  let issuesRefreshTokens = true;
  let accessTokenLifetimeSeconds = DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
  // While true the UserInfo and token endpoints drop the connection, as if the IdP were down.
  let isUnavailable = false;
  let lastSid: string | null = null;
  const issueTokens = (subject: string) => {
    const accessToken = `mock-access-${randomBytes(12).toString('hex')}`;
    accessTokens.set(accessToken, subject);
    const refreshToken = issuesRefreshTokens
      ? `mock-refresh-${randomBytes(12).toString('hex')}`
      : undefined;
    if (refreshToken) refreshTokens.set(refreshToken, subject);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenLifetimeSeconds,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  };
  const wrongKey = await generateKeyPair('RS256');
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', issuer);
      const json = (value: unknown, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === '/.well-known/openid-configuration')
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          grant_types_supported: ['authorization_code', 'refresh_token'],
          backchannel_logout_supported: true,
          backchannel_logout_session_supported: true,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        });
      if (url.pathname === '/jwks') return json({ keys: [publicKey] });
      if (url.pathname === '/authorize') {
        if (
          url.searchParams.get('client_id') !== 'mmt-test' ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !url.searchParams.get('nonce')
        )
          return json({ error: 'invalid_request' }, 400);
        const code = randomBytes(16).toString('hex');
        const redirectUri = url.searchParams.get('redirect_uri')!;
        authorizations.set(code, {
          nonce: url.searchParams.get('nonce')!,
          challenge: url.searchParams.get('code_challenge')!,
          redirectUri,
        });
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        response.writeHead(302, { Location: callback.href });
        response.end();
        return;
      }
      if (url.pathname === '/userinfo') {
        userInfoRequests++;
        if (isUnavailable) return request.socket.destroy();
        const accessToken = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
        const subject = accessTokens.get(accessToken);
        if (!subject) {
          response.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
          response.end();
          return;
        }
        return json({
          sub: subject,
          email: claims.email,
          email_verified: claims.emailVerified,
          name: claims.name,
          groups: claims.groups,
        });
      }
      if (url.pathname === '/token') {
        tokenRequests++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        if (body.get('grant_type') === 'refresh_token') {
          refreshRequests++;
          if (isUnavailable) return request.socket.destroy();
          const refreshToken = body.get('refresh_token') ?? '';
          const subject = refreshTokens.get(refreshToken);
          // Rotation as in Authentik: a refresh token works once.
          refreshTokens.delete(refreshToken);
          if (!subject) return json({ error: 'invalid_grant' }, 400);
          return json(issueTokens(subject));
        }
        const code = body.get('code') ?? '';
        const authorization = authorizations.get(code);
        authorizations.delete(code);
        if (!authorization) return json({ error: 'invalid_grant' }, 400);
        const encodedCredentials = request.headers.authorization?.match(/^Basic (.+)$/i)?.[1];
        const credentials = encodedCredentials
          ? Buffer.from(encodedCredentials, 'base64')
              .toString()
              .split(':')
              .map((value) => decodeURIComponent(value.replace(/\+/g, ' ')))
          : [];
        const checks = {
          clientAuthentication:
            credentials[0] === 'mmt-test' && credentials[1] === 'mock-client-secret',
          redirectUri: authorization?.redirectUri === body.get('redirect_uri'),
          pkce:
            authorization?.challenge ===
            createHash('sha256')
              .update(body.get('code_verifier') ?? '')
              .digest('base64url'),
        };
        if (Object.values(checks).some((value) => !value))
          return json({ error: 'invalid_grant' }, 400);
        lastSid = `mock-sid-${randomBytes(8).toString('hex')}`;
        const idToken = await new SignJWT({
          sid: lastSid,
          email: claims.email,
          email_verified: claims.emailVerified,
          name: claims.name,
          groups: claims.groups,
          nonce: shouldReturnWrongNonce ? 'wrong-nonce' : authorization.nonce,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'mock-signing-key' })
          .setSubject(claims.subject)
          .setIssuer(issuer)
          .setAudience('mmt-test')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(shouldSignWithWrongKey ? wrongKey.privateKey : keyPair.privateKey);
        return json({ ...issueTokens(claims.subject), id_token: idToken });
      }
      return json({ error: 'not_found' }, 404);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock provider failed to listen');
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    get tokenRequests() {
      return tokenRequests;
    },
    get refreshRequests() {
      return refreshRequests;
    },
    get userInfoRequests() {
      return userInfoRequests;
    },
    // The sid of the most recent ID token, which back-channel logout tokens may name.
    get lastSid() {
      return lastSid;
    },
    unavailable(value: boolean) {
      isUnavailable = value;
    },
    // false acts as an IdP without offline_access: no refresh token is issued.
    issueRefreshTokens(value: boolean) {
      issuesRefreshTokens = value;
    },
    accessTokenLifetime(seconds: number) {
      accessTokenLifetimeSeconds = seconds;
    },
    // As when the user signs out at the IdP: issued tokens stop working.
    revokeAllTokens() {
      accessTokens.clear();
      refreshTokens.clear();
    },
    revokeAccessTokens() {
      accessTokens.clear();
    },
    async logoutToken(token: MockLogoutToken = {}): Promise<string> {
      const payload: Record<string, unknown> = {
        events: 'events' in token ? token.events : { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      };
      if (token.sid) payload.sid = token.sid;
      if (token.nonce) payload.nonce = token.nonce;
      const jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: 'mock-signing-key', typ: 'logout+jwt' })
        .setIssuer(token.issuer ?? issuer)
        .setAudience(token.audience ?? 'mmt-test')
        .setIssuedAt(token.issuedAt ?? new Date())
        .setJti(token.jti ?? randomBytes(12).toString('hex'));
      if (token.subject) jwt.setSubject(token.subject);
      return jwt.sign(token.signWithWrongKey ? wrongKey.privateKey : keyPair.privateKey);
    },
    wrongNonce(value: boolean) {
      shouldReturnWrongNonce = value;
    },
    wrongSignature(value: boolean) {
      shouldSignWithWrongKey = value;
    },
    // Changes apply to the next token response; resetClaims returns to the default account.
    setClaims(change: Partial<MockOidcClaims>) {
      claims = { ...claims, ...change };
    },
    resetClaims() {
      claims = { ...DEFAULT_CLAIMS };
    },
    // Back to a healthy IdP that issues refresh tokens, for test isolation.
    resetBehavior() {
      isUnavailable = false;
      issuesRefreshTokens = true;
      accessTokenLifetimeSeconds = DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
      tokenRequests = 0;
      refreshRequests = 0;
      userInfoRequests = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
