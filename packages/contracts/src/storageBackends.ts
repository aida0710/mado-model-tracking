/** Where an Artifact backend's settings come from. Environment backends are read-only. */
export type StorageBackendSource = 'environment' | 'database';
export type StorageBackendKind = 'filesystem' | 's3';

/** The secret access key is never returned; secretConfigured tells whether one is stored. */
export interface StorageBackend {
  /** Immutable; artifacts.backend and projects.artifact_backend refer to it. */
  name: string;
  kind: StorageBackendKind;
  source: StorageBackendSource;
  rootPath?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  pathStyle?: boolean;
  signatureVersion: 'v4' | 'v2';
  tlsVerify: boolean;
  caBundleConfigured: boolean;
  checksumMode: 'when_required' | 'when_supported';
  multipartPartSizeBytes: number;
  accessKeyId?: string;
  secretConfigured: boolean;
  enabled: boolean;
}
export interface StorageBackendCreate {
  name: string;
  kind: StorageBackendKind;
  rootPath?: string;
  endpoint?: string | null;
  region?: string;
  bucket?: string;
  prefix?: string;
  pathStyle?: boolean;
  signatureVersion?: 'v4' | 'v2';
  tlsVerify?: boolean;
  checksumMode?: 'when_required' | 'when_supported';
  multipartPartSizeBytes?: number;
  /** PEM text; null clears it on update. */
  caBundle?: string | null;
  accessKeyId?: string | null;
  /** Omitted on update keeps the stored secret; null clears it together with accessKeyId. */
  secretAccessKey?: string | null;
  enabled?: boolean;
}
export type StorageBackendPatch = Partial<Omit<StorageBackendCreate, 'name'>>;
export interface StorageSettings {
  defaultBackend: string;
}
export interface StorageTestStep {
  name: 'put' | 'get' | 'range' | 'delete';
  ok: boolean;
  error?: string;
}
export interface StorageTestResult {
  steps: StorageTestStep[];
}
/** GET /storage/backends: backends a Project may choose for new Artifacts. */
export interface StorageBackendChoices {
  items: string[];
  defaultBackend: string;
}
