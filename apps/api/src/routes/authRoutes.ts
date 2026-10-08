import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AuthService } from '../services/authService.js';
import { LOGIN_LIFETIME_SECONDS, SESSION_LIFETIME_SECONDS } from '../services/authService.js';
import { LOGIN_BINDING_COOKIE, SESSION_COOKIE, validateOrigin } from '../http/authMiddleware.js';
import { jsonBody, principal, type ApiEnvironment } from '../http/request.js';

export function authRoutes(auth: AuthService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/config', (context) =>
    context.json({
      mode: auth.config.authMode,
      label: auth.config.authMode === 'oidc' ? 'Authentik' : '開発ログイン',
      loginUrl: '/api/auth/login',
    }),
  );
  routes.get('/me', (context) => context.json({ user: principal(context).user }));
  routes.post('/dev-login', async (context) => {
    validateOrigin(context.req.header('Origin'), auth.config);
    const input = await jsonBody(
      context,
      z.strictObject({
        email: z
          .string()
          .max(254)
          .regex(/^[^\s@]+@[^\s@]+$/)
          .default(auth.config.developmentAdminEmail),
        displayName: z.string().min(1).max(200).optional(),
      }),
    );
    const login = await auth.developmentLogin(input);
    setCookie(context, SESSION_COOKIE, login.session, {
      httpOnly: true,
      secure: auth.config.secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_LIFETIME_SECONDS,
    });
    context.header('Cache-Control', 'no-store');
    return context.json({ user: login.user });
  });
  routes.get('/login', async (context) => {
    const login = await auth.beginLogin();
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
    const login = await auth.finishLogin(callbackUrl, getCookie(context, LOGIN_BINDING_COOKIE));
    deleteCookie(context, LOGIN_BINDING_COOKIE, {
      path: '/api/auth',
      secure: auth.config.secureCookies,
    });
    setCookie(context, SESSION_COOKIE, login.session, {
      httpOnly: true,
      secure: auth.config.secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_LIFETIME_SECONDS,
    });
    context.header('Cache-Control', 'no-store');
    return context.redirect(auth.config.webOrigin);
  });
  routes.post('/logout', async (context) => {
    validateOrigin(context.req.header('Origin'), auth.config);
    await auth.logout(getCookie(context, SESSION_COOKIE));
    deleteCookie(context, SESSION_COOKIE, { path: '/', secure: auth.config.secureCookies });
    return context.body(null, 204);
  });
  return routes;
}
