import type { JsonObject } from './index.js';

/**
 * native: one tar Artifact registered by the SDK (log_checkpoint); manifest lists its contents.
 * mlflow: the files MLflow logged under checkpoints/step-<N>/, one Artifact per file.
 */
export type RunCheckpointSource = 'native' | 'mlflow';

/** A file inside the checkpoint directory; path is relative to that directory. */
export interface RunCheckpointFile {
  path: string;
  sha256: string;
  size: number;
}

export interface RunCheckpointManifest {
  files: RunCheckpointFile[];
  includesOptimizer: boolean;
  framework: string | null;
}

/** A saved Artifact of the checkpoint. For an MLflow checkpoint, path is relative to step-<N>/. */
export interface RunCheckpointArtifact {
  id: string;
  path: string;
  size: number;
  sha256: string;
}

export interface RunCheckpoint {
  id: string;
  projectId: string;
  runId: string;
  step: number;
  source: RunCheckpointSource;
  artifactIds: string[];
  artifacts: RunCheckpointArtifact[];
  manifest: RunCheckpointManifest;
  metadata: JsonObject;
  // false once newer checkpoints exceed the keep count; still usable for a resume.
  retained: boolean;
  // Sum of the saved Artifacts' sizes.
  totalSize: number;
  createdAt: string;
}

export interface RunCheckpointPage {
  items: RunCheckpoint[];
}

/** POST /projects/:p/runs/:r/checkpoints; artifactId is a saved tar Artifact of the same Run. */
export interface RunCheckpointCreate {
  step: number;
  artifactId: string;
  manifest: {
    files: RunCheckpointFile[];
    includesOptimizer?: boolean;
    framework?: string | null;
  };
  metadata?: JsonObject;
}

/** Body of POST /projects/:p/jobs/:j/retry; both omitted starts the new Run from scratch. */
export interface JobRetryRequest {
  checkpointId?: string;
  // Picks the largest step of the retried Run's checkpoints.
  resumeFromLatestCheckpoint?: boolean;
}

/** Run.environment.resume, written by the server when a Run is pinned to a checkpoint. */
export interface RunResumeCheckpointRecord {
  checkpointId: string;
  sourceRunId: string;
  step: number;
}

/** WorkerJob.resumeCheckpoint: what the worker downloads, verifies and mounts read-only. */
export interface WorkerResumeCheckpoint {
  id: string;
  runId: string;
  step: number;
  source: RunCheckpointSource;
  artifacts: RunCheckpointArtifact[];
  manifest: RunCheckpointManifest;
  metadata: JsonObject;
}

// MMT_CHECKPOINT_KEEP_COUNT default: retained checkpoints per Run.
export const DEFAULT_CHECKPOINT_KEEP_COUNT = 5;
// MLflow artifacts under this prefix (checkpoints/step-<N>/...) become checkpoints automatically.
export const MLFLOW_CHECKPOINT_PATH_PREFIX = 'checkpoints/step-';
