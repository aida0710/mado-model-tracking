import {
  SYNC_ARTIFACT_CHECK_MAX_ITEMS,
  SYNC_BATCH_MAX_LOGS,
  SYNC_BATCH_MAX_METRICS,
  SYNC_CLOCK_SKEW_SECONDS,
  SYNC_ORIGIN_MAX_LENGTH,
} from '@mmt/contracts';
import { z } from 'zod';
import { DomainError } from './errors.js';
import {
  isRelativeFilePath,
  jsonObjectSchema,
  logSchema,
  metricSchema,
  nameSchema,
  runKindSchema,
  tagsSchema,
  uuidSchema,
} from './validation.js';

const timestampSchema = z.iso.datetime({ offset: true });
// Same bound as the error a worker reports when a Job ends.
const SYNC_ERROR_MAX_LENGTH = 20000;

export const syncRunCreateSchema = z.strictObject({
  experimentId: uuidSchema,
  name: nameSchema,
  kind: runKindSchema,
  parameters: jsonObjectSchema.default({}),
  tags: tagsSchema.default({}),
  parentRunId: uuidSchema.nullish(),
  startedAt: timestampSchema,
  origin: z.string().trim().min(1).max(SYNC_ORIGIN_MAX_LENGTH).nullish(),
});

export const syncBatchSchema = z.strictObject({
  batchId: uuidSchema,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  metrics: z.array(metricSchema).max(SYNC_BATCH_MAX_METRICS).default([]),
  params: jsonObjectSchema.default({}),
  tags: tagsSchema.default({}),
  logs: z.array(logSchema).max(SYNC_BATCH_MAX_LOGS).default([]),
  status: z
    .strictObject({
      status: z.enum(['finished', 'failed', 'canceled']),
      endedAt: timestampSchema,
      error: z.string().max(SYNC_ERROR_MAX_LENGTH).nullish(),
    })
    .optional(),
});

export const artifactPresenceCheckSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        // Same bound as a stored Artifact path, so a longer path can never be present.
        path: z.string().max(1024).refine(isRelativeFilePath, 'Artifact path must be relative'),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(SYNC_ARTIFACT_CHECK_MAX_ITEMS),
});

export type SyncRunCreateInput = z.infer<typeof syncRunCreateSchema>;
export type SyncBatchInput = z.infer<typeof syncBatchSchema>;
export type ArtifactPresenceCheckInput = z.infer<typeof artifactPresenceCheckSchema>;

/**
 * Client clocks drift, so a time slightly ahead of the server is accepted; anything further is a
 * wrong clock whose records would sort after everything logged online.
 */
export function assertNotFutureTimestamp(
  timestamp: string,
  check: { now: Date; field: 'startedAt' | 'endedAt' },
): void {
  if (Date.parse(timestamp) - check.now.getTime() > SYNC_CLOCK_SKEW_SECONDS * 1000)
    throw new DomainError(
      422,
      `${check.field}が現在時刻より${SYNC_CLOCK_SKEW_SECONDS}秒以上先です。記録したコンピュータの時計を確認してください`,
      'sync_timestamp_in_future',
    );
}
