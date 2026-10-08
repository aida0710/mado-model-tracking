import type { Readable } from 'node:stream';
import type { ArtifactBackend } from '@mmt/contracts';

export interface ArtifactWrite {
  backend: ArtifactBackend;
  key: string;
  body: Readable;
  mimeType: string;
}
export interface ArtifactRead {
  backend: ArtifactBackend;
  key: string;
  range?: string;
}
export interface StoredArtifact {
  size: number;
  sha256: string;
}
export interface ArtifactContent {
  body: Readable;
  size: number;
  totalSize: number;
  status: 200 | 206;
  contentRange?: string;
}
/** One backend multipart upload, identified by the final storage key and the backend's upload id. */
export interface MultipartUploadReference {
  key: string;
  backendUploadId: string;
}
export interface MultipartPartWrite extends MultipartUploadReference {
  partNumber: number;
  body: Readable;
  /** The part must contain exactly this many bytes (the request's Content-Length). */
  size: number;
  /** Lowercase hex SHA-256 the client declared for this part, when it sent one. */
  sha256?: string;
}
export interface StoredMultipartPart {
  size: number;
  sha256: string;
  /** Backend token that identifies this part's bytes when the upload is completed. */
  etag: string;
}
export interface MultipartCompletion extends MultipartUploadReference {
  /** Every part of the object; the store assembles them in ascending part number order. */
  parts: { partNumber: number; size: number; etag: string }[];
}
export interface IncompleteMultipartUpload extends MultipartUploadReference {
  initiatedAt: Date;
}
/**
 * Resumable uploads: parts are stored independently and assembled at the final key on completion.
 * Completion does not hash the object; the caller reads it back once to verify the whole file.
 */
export interface ArtifactMultipartStore {
  createMultipart(target: { key: string; mimeType: string }): Promise<{ backendUploadId: string }>;
  putPart(part: MultipartPartWrite): Promise<StoredMultipartPart>;
  completeMultipart(completion: MultipartCompletion): Promise<void>;
  /** Discards stored parts. Aborting an unknown or already aborted upload succeeds. */
  abortMultipart(upload: MultipartUploadReference): Promise<void>;
  listIncompleteUploads(): Promise<IncompleteMultipartUpload[]>;
  /** Deletes temporary files of interrupted writes not modified since the given time. */
  removeAbandonedStaging(notModifiedSince: Date): Promise<number>;
}
export interface ArtifactStore {
  put(write: Omit<ArtifactWrite, 'backend'>): Promise<StoredArtifact>;
  read(read: Omit<ArtifactRead, 'backend'>): Promise<ArtifactContent>;
  remove(key: string): Promise<void>;
  /** Optional: stores without it accept only single-request uploads. */
  multipart?: ArtifactMultipartStore;
}
export interface ArtifactStores {
  backends(): ArtifactBackend[];
  put(write: ArtifactWrite): Promise<StoredArtifact>;
  read(read: ArtifactRead): Promise<ArtifactContent>;
  remove(reference: { backend: ArtifactBackend; key: string }): Promise<void>;
  /** Returns null when the backend is configured but cannot take resumable uploads. */
  multipart(backend: ArtifactBackend): ArtifactMultipartStore | null;
}
export class ArtifactNotFoundError extends Error {
  constructor() {
    super('Artifact does not exist');
    this.name = 'ArtifactNotFoundError';
  }
}
export class ArtifactRangeError extends Error {
  constructor(readonly totalSize: number) {
    super('Requested byte range is not satisfiable');
    this.name = 'ArtifactRangeError';
  }
}
export class ArtifactBackendError extends Error {
  constructor() {
    super('Artifact backend is not configured');
    this.name = 'ArtifactBackendError';
  }
}
