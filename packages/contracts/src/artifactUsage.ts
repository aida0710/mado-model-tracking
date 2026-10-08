import type { ArtifactBackend } from './index.js';

/** Stored Artifacts of one backend in a Project. Sizes are bytes as recorded at upload. */
export interface ArtifactBackendUsage {
  backend: ArtifactBackend;
  /** Artifacts not deleted, every version included. */
  artifactCount: number;
  totalBytes: number;
  /** Deleted Artifacts whose blob the garbage collector has not removed yet. */
  pendingDeletionCount: number;
  pendingDeletionBytes: number;
  /**
   * Earlier uploads to a path that a newer upload (or an MLflow deletion) replaced and that no
   * model version, CodeVersion, DatasetVersion or kept checkpoint references. They are never
   * removed automatically; a Project admin can delete them.
   */
  unreferencedOldVersionCount: number;
  unreferencedOldVersionBytes: number;
}

/** GET /projects/:p/artifact-usage. */
export interface ArtifactUsage {
  /** Backends that hold any Artifact of the Project, by name. */
  backends: ArtifactBackendUsage[];
  /** Days a deleted Artifact's blob is kept before the garbage collector removes it. */
  deleteGraceDays: number;
}
