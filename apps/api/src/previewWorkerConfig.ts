import { tmpdir } from 'node:os';
import { z } from 'zod';
import { parseSecretKey, type SecretKey } from './security/secretEncryption.js';

const optionalSetting = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);
// New uploads show their preview within a few seconds without the worker busy-polling the DB.
const DEFAULT_POLL_INTERVAL_MS = 5000;
// Decoding a multi-hour recording takes minutes; a tool still running after this is stuck.
const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
// Must stay well below PREVIEW_LEASE_SECONDS (2 h), since one job runs up to three tools.
const MAX_TOOL_TIMEOUT_MS = 40 * 60 * 1000;

const environmentSchema = z.object({
  MMT_DATABASE_URL: optionalSetting,
  DATABASE_URL: optionalSetting,
  MMT_STORAGE_SECRET_KEY: optionalSetting,
  MMT_PREVIEW_FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  MMT_PREVIEW_FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  MMT_PREVIEW_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(DEFAULT_POLL_INTERVAL_MS),
  MMT_PREVIEW_TOOL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(MAX_TOOL_TIMEOUT_MS)
    .default(DEFAULT_TOOL_TIMEOUT_MS),
  MMT_PREVIEW_WORK_DIR: optionalSetting,
});

/** Settings of the preview worker process (previewWorker.ts), separate from the API's. */
export interface PreviewWorkerConfig {
  databaseUrl: string;
  storageSecretKey: SecretKey | null;
  ffmpegPath: string;
  ffprobePath: string;
  pollIntervalMs: number;
  toolTimeoutMs: number;
  workDirectory: string;
}

export function loadPreviewWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PreviewWorkerConfig {
  // Report field names only: environment values can contain credentials.
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const settings = parsed.data;
  const databaseUrl = settings.MMT_DATABASE_URL ?? settings.DATABASE_URL;
  if (!databaseUrl) throw new Error('MMT_DATABASE_URL or DATABASE_URL is required');
  let storageSecretKey: SecretKey | null = null;
  if (settings.MMT_STORAGE_SECRET_KEY) {
    try {
      storageSecretKey = parseSecretKey(settings.MMT_STORAGE_SECRET_KEY);
    } catch {
      throw new Error('MMT_STORAGE_SECRET_KEY must be base64 of 32 bytes');
    }
  }
  return {
    databaseUrl,
    storageSecretKey,
    ffmpegPath: settings.MMT_PREVIEW_FFMPEG_PATH,
    ffprobePath: settings.MMT_PREVIEW_FFPROBE_PATH,
    pollIntervalMs: settings.MMT_PREVIEW_POLL_INTERVAL_MS,
    toolTimeoutMs: settings.MMT_PREVIEW_TOOL_TIMEOUT_MS,
    workDirectory: settings.MMT_PREVIEW_WORK_DIR ?? tmpdir(),
  };
}
