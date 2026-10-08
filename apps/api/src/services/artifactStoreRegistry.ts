import type { ArtifactBackend } from '@mmt/contracts';
import {
  ArtifactBackendDisabledError,
  createArtifactStoreFromConfig,
  createReplaceableArtifactStores,
  type ArtifactContent,
  type ArtifactMultipartStore,
  type ArtifactRead,
  type ArtifactStore,
  type ArtifactStores,
  type ArtifactWrite,
  type ReplaceableArtifactStores,
  type StoredArtifact,
} from '@mmt/platform';
import type { Connection, Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import {
  listStorageBackendRows,
  readDefaultBackend,
  type StorageBackendRow,
} from '../repositories/storageBackendRepository.js';
import { decryptSecret, type SecretKey } from '../security/secretEncryption.js';

// Without a stored setting, new Projects keep using the environment filesystem backend.
export const FALLBACK_DEFAULT_BACKEND = 'filesystem';

/** Associated data that binds an encrypted secret to its backend row. */
export function storageSecretContext(backend: string): string {
  return `storage-backend:${backend}`;
}

export type StorageBackendUnavailableReason = 'secret_key_missing' | 'secret_unreadable';
/** A DB backend whose secret cannot be decrypted with the configured key. */
export class StorageBackendUnavailableError extends Error {
  constructor(readonly reason: StorageBackendUnavailableReason) {
    super(`Storage backend is unavailable: ${reason}`);
    this.name = 'StorageBackendUnavailableError';
  }
}

/** Artifact services pass DomainErrors through, so a disabled backend reaches the client as 409. */
async function translateDisabled<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArtifactBackendDisabledError)
      throw new DomainError(
        409,
        'この保存先は無効になっているため新しいArtifactを保存できません',
        'storage_backend_disabled',
      );
    throw error;
  }
}

/** One environment backend seen as a standalone store, so it fits the replaceable mapping. */
function environmentStore(stores: ArtifactStores, backend: ArtifactBackend): ArtifactStore {
  const multipart = stores.multipart(backend);
  return {
    put: (write) => stores.put({ ...write, backend }),
    read: (read) => stores.read({ ...read, backend }),
    remove: (key) => stores.remove({ backend, key }),
    ...(multipart ? { multipart } : {}),
  };
}

/**
 * The ArtifactStores the application uses: environment backends plus backends stored in the DB.
 * DB backends are loaded once at startup and replaced after every administrator change in this
 * process; another API process sees a change when it next misses an unknown backend name.
 */
export class ArtifactStoreRegistry implements ArtifactStores {
  private readonly stores: ReplaceableArtifactStores;
  private readonly environmentBackends: ReadonlySet<ArtifactBackend>;
  private readonly appliedRevisions = new Map<ArtifactBackend, number>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly options: {
      database: Database;
      environmentStores: ArtifactStores;
      secretKey: SecretKey | null;
    },
  ) {
    const environmentBackends = options.environmentStores.backends();
    this.environmentBackends = new Set(environmentBackends);
    this.stores = createReplaceableArtifactStores(
      Object.fromEntries(
        environmentBackends.map((backend) => [
          backend,
          { store: environmentStore(options.environmentStores, backend), acceptsWrites: true },
        ]),
      ),
    );
  }

  isEnvironmentBackend(backend: ArtifactBackend): boolean {
    return this.environmentBackends.has(backend);
  }

  backends(): ArtifactBackend[] {
    return this.stores.backends();
  }

  /** Backends a Project may choose: configured and not disabled. */
  writableBackends(): ArtifactBackend[] {
    return this.stores.writableBackends();
  }

  async put(write: ArtifactWrite): Promise<StoredArtifact> {
    await this.ensureLoaded();
    return translateDisabled(() => this.stores.put(write));
  }

  async read(read: ArtifactRead): Promise<ArtifactContent> {
    await this.ensureLoaded();
    if (!this.stores.backends().includes(read.backend)) await this.reload();
    return this.stores.read(read);
  }

  async remove(reference: { backend: ArtifactBackend; key: string }): Promise<void> {
    await this.ensureLoaded();
    return this.stores.remove(reference);
  }

  multipart(backend: ArtifactBackend): ArtifactMultipartStore | null {
    const multipart = this.stores.multipart(backend);
    if (!multipart) return null;
    return {
      ...multipart,
      createMultipart: (target) => translateDisabled(() => multipart.createMultipart(target)),
    };
  }

  /** Falls back to 'filesystem' when nothing is stored or the stored backend stopped taking writes. */
  async getDefaultBackend(connection: Connection = this.options.database): Promise<string> {
    const stored = await readDefaultBackend(connection);
    return stored && this.writableBackends().includes(stored) ? stored : FALLBACK_DEFAULT_BACKEND;
  }

  /**
   * Loads DB backends once. A failure (for example before migrations ran) is logged and retried
   * on the next call; environment backends keep working meanwhile.
   */
  ensureLoaded(): Promise<void> {
    this.loading ??= this.reload().catch((error: unknown) => {
      this.loading = null;
      console.error(
        JSON.stringify({ event: 'storage_backends_load_failed', name: (error as Error).name }),
      );
    });
    return this.loading;
  }

  /** Re-reads every DB backend, replacing changed ones and dropping rows that disappeared. */
  async reload(): Promise<void> {
    const backendRows = await listStorageBackendRows(this.options.database);
    const present = new Set(backendRows.map((row) => row.name));
    for (const backend of this.appliedRevisions.keys()) {
      if (present.has(backend)) continue;
      this.stores.delete(backend);
      this.appliedRevisions.delete(backend);
    }
    for (const row of backendRows) this.apply(row);
  }

  /**
   * Swaps in a store built from the row unless a newer revision is already applied. Operations
   * that already looked up the previous store finish on it.
   */
  apply(row: StorageBackendRow): void {
    if (this.isEnvironmentBackend(row.name)) return;
    if ((this.appliedRevisions.get(row.name) ?? 0) >= row.revision) return;
    this.appliedRevisions.set(row.name, row.revision);
    try {
      this.stores.replace(row.name, { store: this.buildStore(row), acceptsWrites: row.enabled });
    } catch (error) {
      if (!(error instanceof StorageBackendUnavailableError)) throw error;
      // Artifacts on this backend answer backend_unavailable until the key is fixed.
      this.stores.delete(row.name);
      console.error(
        JSON.stringify({
          event: 'storage_backend_unavailable',
          backend: row.name,
          reason: error.reason,
        }),
      );
    }
  }

  /** Builds a fresh store from a row; the connection test uses it for disabled backends too. */
  buildStore(row: StorageBackendRow): ArtifactStore {
    return createArtifactStoreFromConfig({
      config: row.config,
      ...(row.accessKeyId ? { credentials: this.credentials(row, row.accessKeyId) } : {}),
      ...(row.caBundle ? { caBundle: row.caBundle } : {}),
    });
  }

  /** The store an environment backend uses, for the connection test. */
  environmentStore(backend: ArtifactBackend): ArtifactStore {
    return environmentStore(this.options.environmentStores, backend);
  }

  private credentials(row: StorageBackendRow, accessKeyId: string) {
    const { secretKey } = this.options;
    if (!row.secretEncrypted || !row.secretKeyId)
      throw new StorageBackendUnavailableError('secret_unreadable');
    if (!secretKey) throw new StorageBackendUnavailableError('secret_key_missing');
    try {
      const secretAccessKey = decryptSecret({
        key: secretKey,
        encrypted: { keyId: row.secretKeyId, payload: row.secretEncrypted },
        context: storageSecretContext(row.name),
      });
      return { accessKeyId, secretAccessKey };
    } catch {
      throw new StorageBackendUnavailableError('secret_unreadable');
    }
  }
}
