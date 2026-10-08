import { z } from 'zod';
import type { AuthMode } from '@mmt/contracts';
import { createOidcRolePolicy, type OidcRolePolicy } from './domain/oidcRolePolicy.js';
import { parseSecretKey, type SecretKey } from './security/secretEncryption.js';
import { DEFAULT_CHECKPOINT_KEEP_COUNT } from '@mmt/contracts';
import { parseSmtpSettings, type SmtpSettings } from '@mmt/platform';

const optionalSetting = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);
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

// Same default as Mado: the identity, display name and email claims the login needs.
const DEFAULT_OIDC_SCOPES = 'openid profile email';

// Idle and absolute limits keep the previous 12-hour session while ending unattended browsers after 8 hours.
const DEFAULT_SESSION_IDLE_SECONDS = 8 * 60 * 60;
const DEFAULT_SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;
// Shorter sessions than these would expire while an operator is still reading a run.
const MIN_SESSION_IDLE_SECONDS = 5 * 60;
const MIN_SESSION_ABSOLUTE_SECONDS = 60 * 60;

// One artifact may hold a full checkpoint set; operators can lower or raise this limit.
const DEFAULT_ARTIFACT_MAX_BYTES = 200 * 1024 ** 3;
// A week lets an administrator notice a mistaken deletion before the bytes are gone (decisions.md).
const DEFAULT_ARTIFACT_DELETE_GRACE_DAYS = 7;
// 0 disables the whole-request deadline so multi-hour uploads are bounded only by idle time.
const DEFAULT_UPLOAD_REQUEST_TIMEOUT_MS = 0;
// A stalled client releases its socket after two minutes without received bytes.
const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 120_000;
// MLflow's mpu/complete is synchronous. The wait stays below the SDK's default 120-second request
// timeout so a slow verification answers 503 instead of the SDK giving up and aborting.
const DEFAULT_UPLOAD_FINALIZE_WAIT_MS = 100_000;
// New API tokens expire within a year; it is also the expiry of a token issued without one.
const DEFAULT_TOKEN_MAX_LIFETIME_DAYS = 365;
// Rows of one CSV export (decisions.md); beyond this Excel use gets slow and the filter should narrow.
const DEFAULT_CSV_EXPORT_MAX_ROWS = 50_000;
// An SSO session asks UserInfo for the current groups at most this often (decisions.md: 60 seconds),
// so a user removed from a group loses access within about a minute even while active.
const DEFAULT_OIDC_RECHECK_SECONDS = 60;
// API tokens of SSO users stop when the last group sync is older than this (decisions.md: 7 days).
const DEFAULT_OIDC_TOKEN_SYNC_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
// Shorter than a minute would sync on nearly every token request and gain nothing.
const MIN_OIDC_TOKEN_SYNC_MAX_AGE_SECONDS = 60;

const environmentSchema = z.object({
  NODE_ENV: z.string().default('development'),
  MMT_DATABASE_URL: optionalSetting,
  DATABASE_URL: optionalSetting,
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4182),
  // hybrid keeps a local administrator as the recovery path while SSO is introduced.
  AUTH_MODE: z.enum(['local', 'oidc', 'hybrid', 'development']).default('hybrid'),
  AUTH_SESSION_IDLE_SECONDS: z.coerce
    .number()
    .int()
    .min(MIN_SESSION_IDLE_SECONDS)
    .default(DEFAULT_SESSION_IDLE_SECONDS),
  AUTH_SESSION_ABSOLUTE_SECONDS: z.coerce
    .number()
    .int()
    .min(MIN_SESSION_ABSOLUTE_SECONDS)
    .default(DEFAULT_SESSION_ABSOLUTE_SECONDS),
  MMT_PUBLIC_URL: z.url().default('http://127.0.0.1:4182'),
  MMT_WEB_ORIGIN: z.url().default('http://127.0.0.1:5182'),
  MMT_ALLOW_PRIVATE_ORIGINS: z.enum(['true', 'false']).default('false'),
  // Validated only when OIDC is enabled, so local mode ignores a leftover value.
  OIDC_ISSUER_URL: optionalSetting,
  OIDC_CLIENT_ID: optionalSetting,
  OIDC_CLIENT_SECRET: optionalSetting,
  OIDC_ALLOWED_GROUPS: optionalSetting,
  OIDC_ROLE_MAPPING_JSON: optionalSetting,
  OIDC_DEFAULT_ROLE: optionalSetting,
  // Shorthand for {"<group>":"admin"}; without it and the mapping, mmt-admins stays the admin group.
  OIDC_ADMIN_GROUP: optionalSetting,
  // Off by default: linking by email would let an IdP account take over a same-email local account.
  OIDC_AUTO_LINK_VERIFIED_EMAIL: z.enum(['true', 'false']).default('false'),
  OIDC_SCOPES: z.string().default(DEFAULT_OIDC_SCOPES),
  OIDC_LABEL: z.string().min(1).max(100).default('Authentik'),
  OIDC_ALLOW_INSECURE_HTTP: z.enum(['true', 'false']).default('false'),
  // base64 of 32 bytes. Encrypts the IdP tokens kept in SSO sessions; required for oidc and hybrid.
  MMT_SESSION_ENCRYPTION_KEY: optionalSetting,
  OIDC_RECHECK_SECONDS: z.coerce.number().int().min(1).default(DEFAULT_OIDC_RECHECK_SECONDS),
  OIDC_TOKEN_SYNC_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(MIN_OIDC_TOKEN_SYNC_MAX_AGE_SECONDS)
    .default(DEFAULT_OIDC_TOKEN_SYNC_MAX_AGE_SECONDS),
  DEVELOPMENT_ADMIN_EMAIL: z
    .string()
    .regex(/^[^\s@]+@[^\s@]+$/)
    .default('admin@localhost'),
  MMT_ALLOW_LOCAL_EXECUTOR: z.enum(['true', 'false']).default('false'),
  MMT_ALLOW_SEED: z.enum(['true', 'false']).default('false'),
  MMT_GIT_SSH_KEY_PATH: optionalSshPath,
  MMT_GIT_KNOWN_HOSTS_PATH: optionalSshPath,
  MMT_ARTIFACT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_ARTIFACT_MAX_BYTES),
  MMT_ARTIFACT_DELETE_GRACE_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .default(DEFAULT_ARTIFACT_DELETE_GRACE_DAYS),
  MMT_UPLOAD_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_UPLOAD_REQUEST_TIMEOUT_MS),
  MMT_UPLOAD_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_UPLOAD_IDLE_TIMEOUT_MS),
  MMT_MLFLOW_MULTIPART_UPLOADS: z.enum(['true', 'false']).default('true'),
  // Presigned downloads are not implemented; true makes MLflow 3.17+ SDK downloads fail.
  MMT_MLFLOW_MULTIPART_DOWNLOADS: z.enum(['true', 'false']).default('false'),
  MMT_UPLOAD_FINALIZE_WAIT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_UPLOAD_FINALIZE_WAIT_MS),
  // base64 of 32 bytes. Without it, storage backends that need a secret cannot be created.
  MMT_STORAGE_SECRET_KEY: optionalSetting,
  MMT_TOKEN_MAX_LIFETIME_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(DEFAULT_TOKEN_MAX_LIFETIME_DAYS),
  MMT_CHECKPOINT_KEEP_COUNT: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_CHECKPOINT_KEEP_COUNT),
  MMT_CSV_EXPORT_MAX_ROWS: z.coerce.number().int().positive().default(DEFAULT_CSV_EXPORT_MAX_ROWS),
  // Email notifications are sent only when both are set; the URL may hold the SMTP password.
  MMT_SMTP_URL: optionalSetting,
  MMT_SMTP_FROM: optionalSetting,
});

export interface ApiConfig {
  databaseUrl: string;
  host: string;
  port: number;
  authMode: AuthMode;
  // True for local and hybrid: username/password login and bootstrap administrators are accepted.
  localLoginEnabled: boolean;
  session: { idleSeconds: number; absoluteSeconds: number };
  publicUrl: string;
  webOrigin: string;
  allowPrivateOrigins: boolean;
  secureCookies: boolean;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    rolePolicy: OidcRolePolicy;
    autoLinkVerifiedEmail: boolean;
    scopes: string;
    label: string;
    allowInsecureHttp: boolean;
    // Encrypts the access and refresh tokens stored with each SSO session.
    sessionEncryptionKey: SecretKey;
    // An SSO session older than this since its last UserInfo check is checked again.
    recheckSeconds: number;
  } | null;
  developmentAdminEmail: string;
  allowLocalExecutor: boolean;
  allowSeed: boolean;
  repositorySsh: { keyPath: string; knownHostsPath: string } | null;
  artifactMaxBytes: number;
  // Days between deleting an Artifact and the garbage collector removing its blob.
  artifactDeleteGraceDays: number;
  // 0 means the timeout is disabled.
  uploadRequestTimeoutMs: number;
  uploadIdleTimeoutMs: number;
  // Advertised by MLflow server-info; uploads=false answers mpu/* with the SDK's fallback 501.
  mlflowMultipart: { uploadsEnabled: boolean; downloadsEnabled: boolean };
  // How long MLflow's mpu/complete waits for the upload finalizer before answering 503.
  uploadFinalizeWaitMs: number;
  // Encrypts storage backend secrets in the DB; null when MMT_STORAGE_SECRET_KEY is unset.
  storageSecretKey: SecretKey | null;
  // Upper limit and default for the lifetime of a new API token.
  tokenMaxLifetimeDays: number;
  // Checkpoints per Run shown by default; older ones get retained=false (their files are kept).
  checkpointKeepCount: number;
  // Rows of POST /runs/search/export.csv; further matches are cut and marked at the end.
  csvExportMaxRows: number;
  // API tokens of users with an SSO identity need a group sync within this many seconds.
  oidcTokenSyncMaxAgeSeconds: number;
  // null leaves email channels saved but undeliverable (email_sender_unavailable).
  smtp: SmtpSettings | null;
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
  if (settings.AUTH_SESSION_IDLE_SECONDS > settings.AUTH_SESSION_ABSOLUTE_SECONDS)
    throw new Error('AUTH_SESSION_IDLE_SECONDS must not exceed AUTH_SESSION_ABSOLUTE_SECONDS');
  let storageSecretKey: SecretKey | null = null;
  if (settings.MMT_STORAGE_SECRET_KEY) {
    try {
      storageSecretKey = parseSecretKey(settings.MMT_STORAGE_SECRET_KEY);
    } catch {
      throw new Error('MMT_STORAGE_SECRET_KEY must be base64 of 32 bytes');
    }
  }
  let oidc: ApiConfig['oidc'] = null;
  // local mode ignores OIDC_* so a leftover SSO setting cannot open a second login path.
  if (settings.AUTH_MODE === 'oidc' || settings.AUTH_MODE === 'hybrid') {
    if (!settings.OIDC_ISSUER_URL || !settings.OIDC_CLIENT_ID)
      throw new Error(
        `OIDC_ISSUER_URL and OIDC_CLIENT_ID are required when AUTH_MODE=${settings.AUTH_MODE}`,
      );
    if (!URL.canParse(settings.OIDC_ISSUER_URL)) throw new Error('OIDC_ISSUER_URL must be a URL');
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
    const scopes = settings.OIDC_SCOPES.split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) throw new Error('OIDC_SCOPES must include openid');
    if (!settings.MMT_SESSION_ENCRYPTION_KEY)
      throw new Error(
        `MMT_SESSION_ENCRYPTION_KEY is required when AUTH_MODE=${settings.AUTH_MODE}`,
      );
    let sessionEncryptionKey: SecretKey;
    try {
      sessionEncryptionKey = parseSecretKey(settings.MMT_SESSION_ENCRYPTION_KEY);
    } catch {
      throw new Error('MMT_SESSION_ENCRYPTION_KEY must be base64 of 32 bytes');
    }
    oidc = {
      issuer: settings.OIDC_ISSUER_URL,
      clientId: settings.OIDC_CLIENT_ID,
      clientSecret: settings.OIDC_CLIENT_SECRET,
      rolePolicy: createOidcRolePolicy({
        allowedGroups: settings.OIDC_ALLOWED_GROUPS,
        roleMappingJson: settings.OIDC_ROLE_MAPPING_JSON,
        defaultRole: settings.OIDC_DEFAULT_ROLE,
        adminGroup: settings.OIDC_ADMIN_GROUP,
      }),
      autoLinkVerifiedEmail: settings.OIDC_AUTO_LINK_VERIFIED_EMAIL === 'true',
      scopes: scopes.join(' '),
      label: settings.OIDC_LABEL,
      allowInsecureHttp,
      sessionEncryptionKey,
      recheckSeconds: settings.OIDC_RECHECK_SECONDS,
    };
  }
  return {
    databaseUrl,
    host: settings.HOST,
    port: settings.PORT,
    authMode: settings.AUTH_MODE,
    localLoginEnabled: settings.AUTH_MODE === 'local' || settings.AUTH_MODE === 'hybrid',
    session: {
      idleSeconds: settings.AUTH_SESSION_IDLE_SECONDS,
      absoluteSeconds: settings.AUTH_SESSION_ABSOLUTE_SECONDS,
    },
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
    artifactMaxBytes: settings.MMT_ARTIFACT_MAX_BYTES,
    artifactDeleteGraceDays: settings.MMT_ARTIFACT_DELETE_GRACE_DAYS,
    uploadRequestTimeoutMs: settings.MMT_UPLOAD_REQUEST_TIMEOUT_MS,
    uploadIdleTimeoutMs: settings.MMT_UPLOAD_IDLE_TIMEOUT_MS,
    mlflowMultipart: {
      uploadsEnabled: settings.MMT_MLFLOW_MULTIPART_UPLOADS === 'true',
      downloadsEnabled: settings.MMT_MLFLOW_MULTIPART_DOWNLOADS === 'true',
    },
    uploadFinalizeWaitMs: settings.MMT_UPLOAD_FINALIZE_WAIT_MS,
    storageSecretKey,
    tokenMaxLifetimeDays: settings.MMT_TOKEN_MAX_LIFETIME_DAYS,
    checkpointKeepCount: settings.MMT_CHECKPOINT_KEEP_COUNT,
    csvExportMaxRows: settings.MMT_CSV_EXPORT_MAX_ROWS,
    oidcTokenSyncMaxAgeSeconds: settings.OIDC_TOKEN_SYNC_MAX_AGE_SECONDS,
    smtp: parseSmtpSettings({ url: settings.MMT_SMTP_URL, from: settings.MMT_SMTP_FROM }),
  };
}
