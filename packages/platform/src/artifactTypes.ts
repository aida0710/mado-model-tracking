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
export interface ArtifactStore {
  put(write: Omit<ArtifactWrite, 'backend'>): Promise<StoredArtifact>;
  read(read: Omit<ArtifactRead, 'backend'>): Promise<ArtifactContent>;
  remove(key: string): Promise<void>;
}
export interface ArtifactStores {
  backends(): ArtifactBackend[];
  put(write: ArtifactWrite): Promise<StoredArtifact>;
  read(read: ArtifactRead): Promise<ArtifactContent>;
  remove(reference: { backend: ArtifactBackend; key: string }): Promise<void>;
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
