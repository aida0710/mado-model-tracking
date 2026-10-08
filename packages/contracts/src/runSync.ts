import type { JsonObject, LogEntry, MetricPoint, RunKind } from './index.js';

/**
 * Offline sync: a client records a Run where the API is unreachable and sends it later. The
 * client chooses the Run ID and each batch ID, so resending after a failure never duplicates.
 */

/** PUT /projects/:p/sync/runs/:runId. Creates the Run with that ID or returns the existing one. */
export interface SyncRunCreate {
  experimentId: string;
  name: string;
  kind: RunKind;
  parameters?: JsonObject;
  tags?: Record<string, string>;
  parentRunId?: string | null;
  // When the client started the Run; up to SYNC_CLOCK_SKEW_SECONDS in the future is accepted.
  startedAt: string;
  // Label of the machine that recorded the Run, stored as Run.syncOrigin.
  origin?: string | null;
}

export type SyncTerminalStatus = 'finished' | 'failed' | 'canceled';

export interface SyncBatchStatus {
  status: SyncTerminalStatus;
  endedAt: string;
  error?: string | null;
}

/** POST /projects/:p/sync/runs/:runId/batches. A batchId already received is not applied again. */
export interface SyncBatch {
  batchId: string;
  // Client order of the batch; stored for diagnosis, gaps are neither rejected nor filled.
  sequence: number;
  metrics?: MetricPoint[];
  params?: JsonObject;
  tags?: Record<string, string>;
  logs?: LogEntry[];
  status?: SyncBatchStatus;
}

export interface SyncBatchCounts {
  metrics: number;
  params: number;
  tags: number;
  logs: number;
}

/** duplicate=true means the batchId was already applied; counts are from that first time. */
export interface SyncBatchResult {
  applied: boolean;
  duplicate: boolean;
  counts: SyncBatchCounts;
}

export interface ArtifactPresenceItem {
  path: string;
  sha256: string;
  size: number;
}

/** POST /projects/:p/sync/runs/:runId/artifacts/check */
export interface ArtifactPresenceCheck {
  items: ArtifactPresenceItem[];
}

/** Paths whose stored Artifact on the Run has the same sha256 and size; the rest must be uploaded. */
export interface ArtifactPresence {
  present: string[];
}

export const SYNC_CLOCK_SKEW_SECONDS = 300;
export const SYNC_BATCH_MAX_METRICS = 10000;
export const SYNC_BATCH_MAX_LOGS = 10000;
export const SYNC_ARTIFACT_CHECK_MAX_ITEMS = 1000;
export const SYNC_ORIGIN_MAX_LENGTH = 200;
