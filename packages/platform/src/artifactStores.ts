import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import type { ArtifactBackend } from '@mmt/contracts';
import { createFilesystemArtifactStore } from './filesystemArtifactStore.js';
import { createS3ArtifactStore } from './s3ArtifactStore.js';
import { createS3Client, type S3Credentials } from './s3ClientFactory.js';
import type { StorageBackendConfig } from './storageBackendConfig.js';
import {
  ArtifactBackendError,
  type ArtifactMultipartStore,
  type ArtifactStore,
  type ArtifactStores,
} from './artifactTypes.js';

export function createArtifactStores(
  stores: Partial<Record<ArtifactBackend, ArtifactStore>>,
): ArtifactStores {
  function configuredStore(backend: ArtifactBackend): ArtifactStore {
    const store = stores[backend];
    if (!store) throw new ArtifactBackendError();
    return store;
  }
  return {
    backends: () => Object.keys(stores) as ArtifactBackend[],
    put: ({ backend, ...write }) => configuredStore(backend).put(write),
    read: ({ backend, ...read }) => configuredStore(backend).read(read),
    remove: ({ backend, key }) => configuredStore(backend).remove(key),
    multipart: (backend) => configuredStore(backend).multipart ?? null,
  };
}

interface EnvironmentS3Settings {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: S3Credentials;
}
function readEnvironmentS3Settings(env: NodeJS.ProcessEnv): EnvironmentS3Settings | null {
  if (!env.S3_BUCKET) return null;
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY))
    throw new Error('S3 credential fields must be configured together');
  return {
    bucket: env.S3_BUCKET,
    prefix: env.S3_PREFIX ?? '',
    region: env.S3_REGION ?? 'us-east-1',
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  };
}
function environmentFilesystemRoot(env: NodeJS.ProcessEnv): string {
  return env.ARTIFACT_FILESYSTEM_ROOT ?? path.resolve('var/artifacts');
}

export function createArtifactStoresFromEnv(env: NodeJS.ProcessEnv = process.env): ArtifactStores {
  const stores: Partial<Record<ArtifactBackend, ArtifactStore>> = {
    filesystem: createFilesystemArtifactStore(environmentFilesystemRoot(env)),
  };
  const s3 = readEnvironmentS3Settings(env);
  if (s3) {
    // Environment backends keep the SDK defaults they always had; DB backends use s3ClientFactory.
    const client = new S3Client({
      region: s3.region,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      forcePathStyle: s3.forcePathStyle,
      ...(s3.credentials ? { credentials: s3.credentials } : {}),
    });
    stores.s3 = createS3ArtifactStore({ client, bucket: s3.bucket, prefix: s3.prefix });
  }
  return createArtifactStores(stores);
}

/** Non-secret facts about an environment backend, shown read-only to administrators. */
export type EnvironmentBackendDescription =
  | { name: string; kind: 'filesystem'; rootPath: string }
  | {
      name: string;
      kind: 's3';
      endpoint?: string;
      region: string;
      bucket: string;
      prefix: string;
      pathStyle: boolean;
      secretConfigured: boolean;
    };

export function describeEnvironmentBackends(
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentBackendDescription[] {
  const descriptions: EnvironmentBackendDescription[] = [
    { name: 'filesystem', kind: 'filesystem', rootPath: environmentFilesystemRoot(env) },
  ];
  const s3 = readEnvironmentS3Settings(env);
  if (s3)
    descriptions.push({
      name: 's3',
      kind: 's3',
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      region: s3.region,
      bucket: s3.bucket,
      prefix: s3.prefix,
      pathStyle: s3.forcePathStyle,
      secretConfigured: Boolean(s3.credentials),
    });
  return descriptions;
}

/** Builds the store for one DB-configured backend. The caller decrypts the secret beforehand. */
export function createArtifactStoreFromConfig({
  config,
  credentials,
  caBundle,
}: {
  config: StorageBackendConfig;
  credentials?: S3Credentials;
  caBundle?: string;
}): ArtifactStore {
  if (config.kind === 'filesystem') return createFilesystemArtifactStore(config.rootPath);
  return createS3ArtifactStore({
    client: createS3Client({ config, credentials, caBundle }),
    bucket: config.bucket,
    prefix: config.prefix,
    multipartPartSizeBytes: config.multipartPartSizeBytes,
    multipartEnabled: config.multipartEnabled,
  });
}

/** The backend exists but an administrator disabled it; its Artifacts stay readable. */
export class ArtifactBackendDisabledError extends Error {
  constructor(readonly backend: ArtifactBackend) {
    super('Artifact backend does not accept new writes');
    this.name = 'ArtifactBackendDisabledError';
  }
}

export interface ArtifactStoreEntry {
  store: ArtifactStore;
  acceptsWrites: boolean;
}
export interface ReplaceableArtifactStores extends ArtifactStores {
  /** Backends that take new Artifacts; backends() also lists read-only ones. */
  writableBackends(): ArtifactBackend[];
  /** Later calls use the new entry; operations already started finish on the previous store. */
  replace(backend: ArtifactBackend, entry: ArtifactStoreEntry): void;
  delete(backend: ArtifactBackend): void;
}

function readOnlyMultipart(
  backend: ArtifactBackend,
  multipart: ArtifactMultipartStore,
): ArtifactMultipartStore {
  return {
    ...multipart,
    createMultipart: async () => {
      throw new ArtifactBackendDisabledError(backend);
    },
  };
}

/**
 * Name to store mapping that can change while the server runs. Each call looks up the entry once
 * and keeps that reference, so a replaced store is never mixed into an operation in progress.
 * Disabled backends refuse put() and new multipart uploads; parts of an upload already opened
 * may still finish, so a session started before disabling is not stranded.
 */
export function createReplaceableArtifactStores(
  initial: Record<ArtifactBackend, ArtifactStoreEntry> = {},
): ReplaceableArtifactStores {
  const entries = new Map<ArtifactBackend, ArtifactStoreEntry>(Object.entries(initial));
  function entryOf(backend: ArtifactBackend): ArtifactStoreEntry {
    const entry = entries.get(backend);
    if (!entry) throw new ArtifactBackendError();
    return entry;
  }
  return {
    backends: () => [...entries.keys()],
    writableBackends: () =>
      [...entries].filter(([, entry]) => entry.acceptsWrites).map(([backend]) => backend),
    put: async ({ backend, ...write }) => {
      const entry = entryOf(backend);
      if (!entry.acceptsWrites) throw new ArtifactBackendDisabledError(backend);
      return entry.store.put(write);
    },
    read: async ({ backend, ...read }) => entryOf(backend).store.read(read),
    remove: async ({ backend, key }) => entryOf(backend).store.remove(key),
    multipart: (backend) => {
      const entry = entryOf(backend);
      if (!entry.store.multipart) return null;
      return entry.acceptsWrites
        ? entry.store.multipart
        : readOnlyMultipart(backend, entry.store.multipart);
    },
    replace: (backend, entry) => {
      entries.set(backend, entry);
    },
    delete: (backend) => {
      entries.delete(backend);
    },
  };
}
