import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import type { ArtifactBackend } from '@mmt/contracts';
import { createFilesystemArtifactStore } from './filesystemArtifactStore.js';
import { createS3ArtifactStore } from './s3ArtifactStore.js';
import { ArtifactBackendError, type ArtifactStore, type ArtifactStores } from './artifactTypes.js';

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
  };
}
export function createArtifactStoresFromEnv(env: NodeJS.ProcessEnv = process.env): ArtifactStores {
  const stores: Partial<Record<ArtifactBackend, ArtifactStore>> = {
    filesystem: createFilesystemArtifactStore(
      env.ARTIFACT_FILESYSTEM_ROOT ?? path.resolve('var/artifacts'),
    ),
  };
  if (env.S3_BUCKET) {
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY))
      throw new Error('S3 credential fields must be configured together');
    const client = new S3Client({
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
    });
    stores.s3 = createS3ArtifactStore({
      client,
      bucket: env.S3_BUCKET,
      prefix: env.S3_PREFIX ?? '',
    });
  }
  return createArtifactStores(stores);
}
