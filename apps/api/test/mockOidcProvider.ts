import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

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
  let claims: MockOidcClaims = { ...DEFAULT_CLAIMS };
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
          jwks_uri: `${issuer}/jwks`,
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
      if (url.pathname === '/token') {
        tokenRequests++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
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
        const idToken = await new SignJWT({
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
        return json({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
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
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
