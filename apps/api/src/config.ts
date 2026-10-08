import { z } from 'zod';

const optionalSetting = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
// Operator-owned SSH paths are never accepted from repository request bodies.
const optionalSshPath = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .min(1)
    .max(4000)
    .refine((value) => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value))
    .optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.string().default('development'),
  MMT_DATABASE_URL: optionalSetting,
  DATABASE_URL: optionalSetting,
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4182),
  AUTH_MODE: z.enum(['oidc', 'development']).default('oidc'),
  MMT_PUBLIC_URL: z.url().default('http://127.0.0.1:4182'),
  MMT_WEB_ORIGIN: z.url().default('http://127.0.0.1:5182'),
  MMT_ALLOW_PRIVATE_ORIGINS: z.enum(['true', 'false']).default('false'),
  OIDC_ISSUER_URL: optionalUrl,
  OIDC_CLIENT_ID: optionalSetting,
  OIDC_CLIENT_SECRET: optionalSetting,
  OIDC_ADMIN_GROUP: z.string().default('mmt-admins'),
  OIDC_ALLOW_INSECURE_HTTP: z.enum(['true', 'false']).default('false'),
  DEVELOPMENT_ADMIN_EMAIL: z
    .string()
    .regex(/^[^\s@]+@[^\s@]+$/)
    .default('admin@localhost'),
  MMT_ALLOW_LOCAL_EXECUTOR: z.enum(['true', 'false']).default('false'),
  MMT_ALLOW_SEED: z.enum(['true', 'false']).default('false'),
  MMT_GIT_SSH_KEY_PATH: optionalSshPath,
  MMT_GIT_KNOWN_HOSTS_PATH: optionalSshPath,
});

export interface ApiConfig {
  databaseUrl: string;
  host: string;
  port: number;
  authMode: 'oidc' | 'development';
  publicUrl: string;
  webOrigin: string;
  allowPrivateOrigins: boolean;
  secureCookies: boolean;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    adminGroup: string;
    allowInsecureHttp: boolean;
  } | null;
  developmentAdminEmail: string;
  allowLocalExecutor: boolean;
  allowSeed: boolean;
  repositorySsh: { keyPath: string; knownHostsPath: string } | null;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Report field names only: environment values can contain credentials.
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const settings = parsed.data;
  if (!!settings.MMT_GIT_SSH_KEY_PATH !== !!settings.MMT_GIT_KNOWN_HOSTS_PATH)
    throw new Error('MMT_GIT_SSH_KEY_PATH and MMT_GIT_KNOWN_HOSTS_PATH must be set together');
  const databaseUrl = settings.MMT_DATABASE_URL ?? settings.DATABASE_URL;
  if (!databaseUrl) throw new Error('MMT_DATABASE_URL or DATABASE_URL is required');
  const isProduction = settings.NODE_ENV === 'production';
  if (isProduction && settings.AUTH_MODE === 'development')
    throw new Error('Development authentication is forbidden in production');
  const publicUrl = new URL(settings.MMT_PUBLIC_URL);
  const webUrl = new URL(settings.MMT_WEB_ORIGIN);
  if (![publicUrl, webUrl].every((url) => ['http:', 'https:'].includes(url.protocol)))
    throw new Error('Public URLs require HTTP or HTTPS');
  if (publicUrl.username || publicUrl.password || webUrl.username || webUrl.password)
    throw new Error('Public URLs must not contain credentials');
  if (isProduction && (publicUrl.protocol !== 'https:' || webUrl.protocol !== 'https:'))
    throw new Error('Production URLs require HTTPS');
  const allowInsecureHttp = settings.OIDC_ALLOW_INSECURE_HTTP === 'true';
  if (isProduction && allowInsecureHttp)
    throw new Error('Insecure OIDC transport is forbidden in production');
  let oidc: ApiConfig['oidc'] = null;
  if (settings.AUTH_MODE === 'oidc') {
    if (!settings.OIDC_ISSUER_URL || !settings.OIDC_CLIENT_ID)
      throw new Error('OIDC_ISSUER_URL and OIDC_CLIENT_ID are required');
    const issuerUrl = new URL(settings.OIDC_ISSUER_URL);
    if (issuerUrl.username || issuerUrl.password)
      throw new Error('OIDC issuer must not contain credentials');
    if (
      issuerUrl.protocol !== 'https:' &&
      !(
        allowInsecureHttp &&
        issuerUrl.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(issuerUrl.hostname)
      )
    ) {
      throw new Error(
        'OIDC issuer requires HTTPS; insecure HTTP is permitted only for an explicit loopback test provider',
      );
    }
    oidc = {
      issuer: settings.OIDC_ISSUER_URL,
      clientId: settings.OIDC_CLIENT_ID,
      clientSecret: settings.OIDC_CLIENT_SECRET,
      adminGroup: settings.OIDC_ADMIN_GROUP,
      allowInsecureHttp,
    };
  }
  return {
    databaseUrl,
    host: settings.HOST,
    port: settings.PORT,
    authMode: settings.AUTH_MODE,
    publicUrl: publicUrl.origin,
    webOrigin: webUrl.origin,
    allowPrivateOrigins: settings.MMT_ALLOW_PRIVATE_ORIGINS === 'true',
    secureCookies: publicUrl.protocol === 'https:',
    oidc,
    developmentAdminEmail: settings.DEVELOPMENT_ADMIN_EMAIL.toLowerCase(),
    allowLocalExecutor:
      settings.AUTH_MODE === 'development' && settings.MMT_ALLOW_LOCAL_EXECUTOR === 'true',
    allowSeed: settings.AUTH_MODE === 'development' && settings.MMT_ALLOW_SEED === 'true',
    repositorySsh:
      settings.MMT_GIT_SSH_KEY_PATH && settings.MMT_GIT_KNOWN_HOSTS_PATH
        ? {
            keyPath: settings.MMT_GIT_SSH_KEY_PATH,
            knownHostsPath: settings.MMT_GIT_KNOWN_HOSTS_PATH,
          }
        : null,
  };
}
