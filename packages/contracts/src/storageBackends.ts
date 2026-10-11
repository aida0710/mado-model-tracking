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
  /** S3 only; false stores each Artifact with one PUT and refuses upload sessions. Absent = true. */
  multipartEnabled?: boolean;
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
  multipartEnabled?: boolean;
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

/**
 * GET /admin/storage-directories?path=: directories on the API server that complete a
 * filesystem backend's rootPath as it is typed. A relative path is resolved the way the
 * filesystem backend resolves rootPath (from the API's working directory).
 */
export interface DirectorySuggestions {
  /** The typed path made absolute. */
  resolvedPath: string;
  /**
   * What resolvedPath is now; a missing directory is not an error here. 'unavailable': the API
   * server could not read it in time (a mount that stopped answering), so nothing is known.
   */
  status: 'directory' | 'missing' | 'not_directory' | 'unavailable';
  /**
   * Absolute paths of the directories that complete the typed path, sorted by name: the children
   * of the typed directory when it ends with "/", otherwise its siblings whose names start with
   * the last segment. Names starting with "." appear only when the last segment starts with ".".
   */
  items: string[];
  /** More directories matched than items holds. */
  truncated: boolean;
}
