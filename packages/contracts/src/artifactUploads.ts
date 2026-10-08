import type { ArtifactBackend } from './index.js';

/**
 * open: parts are accepted. verifying: complete was requested and the server assembles and hashes
 * the object. completed: the Artifact `artifactId` exists. aborted/expired/failed are terminal and
 * keep no stored bytes.
 */
export type ArtifactUploadStatus =
  'open' | 'verifying' | 'completed' | 'aborted' | 'expired' | 'failed';

/** Resumable upload session for one Artifact. Parts are numbered from 1 to partCount. */
export interface ArtifactUpload {
  id: string;
  projectId: string;
  runId: string | null;
  path: string;
  backend: ArtifactBackend;
  mimeType: string;
  expectedSize: number;
  expectedSha256: string | null;
  /** Every part except the last has exactly this size; the last holds the remainder. */
  partSize: number;
  partCount: number;
  status: ArtifactUploadStatus;
  /** The registered Artifact once completed. Its id equals the upload id. */
  artifactId: string | null;
  /** Failure code when status is failed, for example `sha256_mismatch`. */
  error: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactUploadPart {
  partNumber: number;
  size: number;
  sha256: string;
  receivedAt: string;
}

/** GET of one session: the received parts tell a resuming client which parts to send again. */
export interface ArtifactUploadDetail extends ArtifactUpload {
  receivedParts: ArtifactUploadPart[];
}

export interface ArtifactUploadCreate {
  path: string;
  runId?: string;
  mimeType?: string;
  expectedSize: number;
  expectedSha256?: string;
  partSize?: number;
}
