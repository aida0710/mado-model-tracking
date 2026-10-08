import { Hono } from 'hono';
import type { AuthConfig, AuthMe } from '@mmt/contracts';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AuthService } from '../services/authService.js';
import { LOGIN_LIFETIME_SECONDS } from '../services/authService.js';
import { RateLimitedError } from '../auth/authRateLimiter.js';
import { DomainError } from '../domain/errors.js';
import { LOGIN_BINDING_COOKIE, SESSION_COOKIE, validateOrigin } from '../http/authMiddleware.js';
import { jsonBody, principal, type ApiContext, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';

// Generous bounds: the hasher enforces the real password rules, these only cap request size.
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_INPUT_LENGTH = 4096;
// A signed logout token is a few KB; the form body is read whole, so it is capped well above that.
const MAX_BACKCHANNEL_LOGOUT_BODY_BYTES = 20_000;

export const localLoginSchema = z.strictObject({
  username: z.string().min(1).max(MAX_USERNAME_LENGTH),
  password: z.string().min(1).max(MAX_PASSWORD_INPUT_LENGTH),
});
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_INPUT_LENGTH),
  newPassword: z.string().min(1).max(MAX_PASSWORD_INPUT_LENGTH),
});

// The email defaults to the configured development administrator.
export function developmentLoginSchema(defaultEmail: string) {
  return z.strictObject({
    email: z
      .string()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+$/)
      .default(defaultEmail),
    displayName: z.string().min(1).max(200).optional(),
  });
}

// The shared error handler builds the 429 body; Retry-After has to be set on the context first.
async function withRetryAfter<T>(context: ApiContext, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RateLimitedError)
      context.header('Retry-After', String(error.retryAfterSeconds));
    throw error;
  }
}

export function authRoutes(auth: AuthService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  const setSessionCookie = (context: ApiContext, session: string) => {
    setCookie(context, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: auth.config.secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: auth.config.session.absoluteSeconds,
    });
    context.header('Cache-Control', 'no-store');
  };

  routes.get('/config', (context) =>
    context.json<AuthConfig>({
      mode: auth.config.authMode,
      methods: {
        local: auth.config.localLoginEnabled,
        oidc: auth.config.oidc
          ? { label: auth.config.oidc.label, loginUrl: '/api/auth/login' }
          : null,
      },
    }),
  );
  routes.get('/me', (context) => {
    const current = principal(context);
    return context.json<AuthMe>({
      user: current.user,
      mustChangePassword: current.session?.mustChangePassword ?? false,
    });
  });
  routes.post('/dev-login', async (context) => {
    validateOrigin(context.req.header('Origin'), auth.config);
    const input = await jsonBody(context, developmentLoginSchema(auth.config.developmentAdminEmail));
    const login = await auth.developmentLogin(input, requestMetadata(context));
    setSessionCookie(context, login.session);
    return context.json({ user: login.user });
  });
  routes.post('/local-login', async (context) => {
    validateOrigin(context.req.header('Origin'), auth.config);
    const input = await jsonBody(context, localLoginSchema);
    const login = await withRetryAfter(context, () =>
      auth.local.login(input, requestMetadata(context)),
    );
    setSessionCookie(context, login.session);
    return context.json<AuthMe>({ user: login.user, mustChangePassword: login.mustChangePassword });
  });
  routes.post('/change-password', async (context) => {
    const current = principal(context);
    const input = await jsonBody(context, changePasswordSchema);
    await withRetryAfter(context, () =>
      auth.local.changePassword(current, input, requestMetadata(context)),
    );
    return context.body(null, 204);
  });
  routes.get('/login', async (context) => {
    const login = await withRetryAfter(context, () => auth.beginLogin(requestMetadata(context)));
    setCookie(context, LOGIN_BINDING_COOKIE, login.binding, {
      httpOnly: true,
      secure: auth.config.secureCookies,
      sameSite: 'Lax',
      path: '/api/auth',
      maxAge: LOGIN_LIFETIME_SECONDS,
    });
    context.header('Cache-Control', 'no-store');
    return context.redirect(login.url);
  });
  routes.get('/callback', async (context) => {
    const callbackUrl = new URL('/api/auth/callback', auth.config.publicUrl);
    callbackUrl.search = new URL(context.req.url).search;
    const login = await auth.finishLogin(
      callbackUrl,
      getCookie(context, LOGIN_BINDING_COOKIE),
      requestMetadata(context),
    );
    deleteCookie(context, LOGIN_BINDING_COOKIE, {
      path: '/api/auth',
      secure: auth.config.secureCookies,
    });
    setSessionCookie(context, login.session);
    return context.redirect(auth.config.webOrigin);
  });
  // Called by the IdP, not a browser: no cookie and no Origin, so it is authenticated by the
  // logout token's signature alone (see OidcBackchannelLogout).
  routes.post('/oidc/backchannel-logout', async (context) => {
    context.header('Cache-Control', 'no-store');
    if (!context.req.header('Content-Type')?.startsWith('application/x-www-form-urlencoded'))
      throw new DomainError(400, 'logout_tokenをform形式で送ってください', 'invalid_logout_token');
    const body = await context.req.text();
    if (Buffer.byteLength(body) > MAX_BACKCHANNEL_LOGOUT_BODY_BYTES)
      throw new DomainError(413, 'logout tokenの上限サイズを超えています', 'body_too_large');
    const logoutToken = new URLSearchParams(body).get('logout_token');
    if (!logoutToken)
      throw new DomainError(400, 'logout_tokenがありません', 'invalid_logout_token');
    await auth.backchannelLogout(logoutToken, requestMetadata(context));
    return context.body(null, 200);
  });
  routes.post('/logout', async (context) => {
    validateOrigin(context.req.header('Origin'), auth.config);
    await auth.logout(
      context.get('principal'),
      getCookie(context, SESSION_COOKIE),
      requestMetadata(context),
    );
    deleteCookie(context, SESSION_COOKIE, { path: '/', secure: auth.config.secureCookies });
    return context.body(null, 204);
  });
  return routes;
}
