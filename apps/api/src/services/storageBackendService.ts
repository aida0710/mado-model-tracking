import type { StorageBackend, StorageSettings, StorageTestResult } from '@mmt/contracts';
import {
  DEFAULT_MULTIPART_PART_SIZE_BYTES,
  isValidStorageBackendName,
  normalizeStorageBackendConfig,
  storageLocationChanged,
  StorageBackendConfigError,
  type ArtifactStore,
  type EnvironmentBackendDescription,
  type StorageBackendConfig,
  type StorageBackendConfigInput,
} from '@mmt/platform';
import type { Principal } from '../auth/principal.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import type {
  StorageBackendCreateInput,
  StorageBackendPatchInput,
} from '../domain/storageBackendValidation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findStorageBackendRow,
  findStorageBackendRowForUpdate,
  insertStorageBackend,
  isStorageBackendReferenced,
  listStorageBackendRows,
  readDefaultBackend,
  updateStorageBackend,
  writeDefaultBackend,
  type StorageBackendRow,
} from '../repositories/storageBackendRepository.js';
import { encryptSecret, type SecretKey } from '../security/secretEncryption.js';
import { requireGlobalAdmin } from './accessService.js';
import {
  ArtifactStoreRegistry,
  FALLBACK_DEFAULT_BACKEND,
  storageSecretContext,
} from './artifactStoreRegistry.js';
import { runConnectionTest } from './storageConnectionTest.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

interface StoredCredentials {
  caBundle: string | null;
  accessKeyId: string | null;
  secretEncrypted: Buffer | null;
  secretKeyId: string | null;
}

/** Picks the location and protocol settings; credentials and enabled are stored separately. */
function configInput(
  input: StorageBackendPatchInput & { kind: StorageBackendConfigInput['kind'] },
): StorageBackendConfigInput {
  return {
    kind: input.kind,
    rootPath: input.rootPath,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    prefix: input.prefix,
    pathStyle: input.pathStyle,
    signatureVersion: input.signatureVersion,
    tlsVerify: input.tlsVerify,
    checksumMode: input.checksumMode,
    multipartPartSizeBytes: input.multipartPartSizeBytes,
    multipartEnabled: input.multipartEnabled,
  };
}

function normalizedConfig(input: StorageBackendConfigInput): StorageBackendConfig {
  try {
    return normalizeStorageBackendConfig(input);
  } catch (error) {
    if (!(error instanceof StorageBackendConfigError)) throw error;
    if (error.code === 'storage_signature_unsupported')
      throw new DomainError(
        422,
        '署名v2はまだ使えません。署名v4を選んでください',
        'storage_signature_unsupported',
      );
    throw new DomainError(422, `保存先の設定が不正です: ${error.field}`, error.code);
  }
}

/** Response shape: settings without the secret, only whether one is stored. */
function publicDatabaseBackend(row: StorageBackendRow): StorageBackend {
  const { config } = row;
  const common = {
    name: row.name,
    source: 'database' as const,
    caBundleConfigured: row.caBundle !== null,
    secretConfigured: row.secretEncrypted !== null,
    enabled: row.enabled,
    ...(row.accessKeyId ? { accessKeyId: row.accessKeyId } : {}),
  };
  if (config.kind === 'filesystem')
    return {
      ...common,
      kind: 'filesystem',
      rootPath: config.rootPath,
      signatureVersion: 'v4',
      tlsVerify: true,
      checksumMode: 'when_required',
      multipartPartSizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
    };
  return { ...common, ...config };
}

/** Environment backends keep the SDK defaults createArtifactStoresFromEnv always used. */
function publicEnvironmentBackend(description: EnvironmentBackendDescription): StorageBackend {
  const common = {
    source: 'environment' as const,
    signatureVersion: 'v4' as const,
    tlsVerify: true,
    caBundleConfigured: false,
    multipartPartSizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
    enabled: true,
  };
  if (description.kind === 'filesystem')
    return {
      ...common,
      ...description,
      checksumMode: 'when_required',
      secretConfigured: false,
    };
  return { ...common, ...description, checksumMode: 'when_supported' };
}

export class StorageBackendService {
  constructor(
    private readonly options: {
      database: Database;
      registry: ArtifactStoreRegistry;
      secretKey: SecretKey | null;
      environmentBackends: EnvironmentBackendDescription[];
    },
  ) {}

  async list(principal: Principal): Promise<StorageBackend[]> {
    requireGlobalAdmin(principal);
    const { registry, environmentBackends, database } = this.options;
    const environment = environmentBackends
      .filter((description) => registry.isEnvironmentBackend(description.name))
      .map(publicEnvironmentBackend);
    const stored = (await listStorageBackendRows(database)).map(publicDatabaseBackend);
    return [...environment, ...stored];
  }

  async create(
    principal: Principal,
    input: StorageBackendCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<StorageBackend> {
    const draft = this.auditDraft(principal, request, 'storage.backend.create', input.name);
    return recordDenial(this.options.database, draft, async () => {
      requireGlobalAdmin(principal);
      if (!isValidStorageBackendName(input.name))
        throw new DomainError(
          422,
          '保存先の名前は小文字英数字とハイフンで指定してください',
          'invalid_storage_backend_name',
        );
      // Environment names are reserved even when that backend is not configured right now.
      if (['filesystem', 's3'].includes(input.name)) this.nameTaken();
      const config = normalizedConfig(configInput(input));
      const credentials = this.storedCredentials({
        config,
        name: input.name,
        current: null,
        patch: input,
      });
      const row = await transaction(this.options.database, async (connection) => {
        if (await findStorageBackendRow(connection, input.name)) this.nameTaken();
        const created = await insertStorageBackend(connection, {
          name: input.name,
          config,
          ...credentials,
          enabled: input.enabled ?? true,
          createdBy: principal.user.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: this.auditDetails(created),
        });
        return created;
      });
      this.options.registry.apply(row);
      return publicDatabaseBackend(row);
    });
  }

  async update(
    principal: Principal,
    name: string,
    patch: StorageBackendPatchInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<StorageBackend> {
    const draft = this.auditDraft(principal, request, 'storage.backend.update', name);
    return recordDenial(this.options.database, draft, async () => {
      requireGlobalAdmin(principal);
      if (this.options.registry.isEnvironmentBackend(name))
        throw new DomainError(
          409,
          '環境変数で設定した保存先は画面やAPIから変更できません',
          'storage_backend_read_only',
        );
      const row = await transaction(this.options.database, async (connection) => {
        const current = await findStorageBackendRowForUpdate(connection, name);
        if (!current) notFound('保存先');
        const kind = patch.kind ?? current.config.kind;
        const kindChanged = kind !== current.config.kind;
        // Settings and credentials of another kind do not carry over; a kind change takes only the patch.
        const base = kindChanged ? { kind } : current.config;
        const config = normalizedConfig(configInput({ ...base, ...patch, kind }));
        if (
          storageLocationChanged(current.config, config) &&
          (await isStorageBackendReferenced(connection, name))
        )
          throw new DomainError(
            409,
            'この保存先を参照するArtifactがあるため、種類・bucket・endpoint・prefix・rootPathは変更できません',
            'storage_backend_in_use',
          );
        const enabled = patch.enabled ?? current.enabled;
        if (!enabled && (await readDefaultBackend(connection)) === name)
          throw new DomainError(
            409,
            '既定の保存先は無効にできません。先に既定を切り替えてください',
            'storage_backend_is_default',
          );
        const updated = await updateStorageBackend(connection, {
          name,
          config,
          ...this.storedCredentials({ config, name, current: kindChanged ? null : current, patch }),
          enabled,
          updatedBy: principal.user.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          // Field names only: the patch itself may carry the secret.
          details: { ...this.auditDetails(updated), changedFields: Object.keys(patch).sort() },
        });
        return updated;
      });
      this.options.registry.apply(row);
      return publicDatabaseBackend(row);
    });
  }

  async test(
    principal: Principal,
    name: string,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<StorageTestResult> {
    const draft = this.auditDraft(principal, request, 'storage.backend.test', name);
    return recordDenial(this.options.database, draft, async () => {
      requireGlobalAdmin(principal);
      const { registry, database } = this.options;
      let openStore: () => ArtifactStore;
      if (registry.isEnvironmentBackend(name)) {
        openStore = () => registry.environmentStore(name);
      } else {
        const row = await findStorageBackendRow(database, name);
        if (!row) notFound('保存先');
        // A fresh store tests the saved settings, including those of a disabled backend.
        openStore = () => registry.buildStore(row);
      }
      const result = await runConnectionTest(openStore);
      const failedStep = result.steps.find((step) => !step.ok)?.name ?? null;
      await writeAuditEvent(database, {
        ...draft,
        outcome: 'success',
        details: { ok: failedStep === null, failedStep },
      });
      return result;
    });
  }

  async getSettings(principal: Principal): Promise<StorageSettings> {
    requireGlobalAdmin(principal);
    return { defaultBackend: await this.options.registry.getDefaultBackend() };
  }

  async updateSettings(
    principal: Principal,
    settings: StorageSettings,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<StorageSettings> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'storage.settings.update',
      resourceType: 'storage_settings',
      resourceId: 'default',
      details: { defaultBackend: settings.defaultBackend },
    };
    return recordDenial(this.options.database, draft, async () => {
      requireGlobalAdmin(principal);
      const { registry, database } = this.options;
      await registry.ensureLoaded();
      await transaction(database, async (connection) => {
        const backend = settings.defaultBackend;
        // The row lock orders this against a concurrent PATCH that disables the backend.
        const row = registry.isEnvironmentBackend(backend)
          ? null
          : await findStorageBackendRowForUpdate(connection, backend);
        const usable = registry.isEnvironmentBackend(backend) || (row?.enabled ?? false);
        if (!usable || !registry.writableBackends().includes(backend))
          throw new DomainError(
            422,
            '既定には有効な保存先だけを指定できます',
            'storage_backend_unavailable',
          );
        const previous = (await readDefaultBackend(connection)) ?? FALLBACK_DEFAULT_BACKEND;
        await writeDefaultBackend(connection, {
          defaultBackend: backend,
          updatedBy: principal.user.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { defaultBackend: backend, previousDefaultBackend: previous },
        });
      });
      return { defaultBackend: settings.defaultBackend };
    });
  }

  private nameTaken(): never {
    throw new DomainError(409, '同じ名前の保存先が既にあります', 'storage_backend_exists');
  }

  private auditDraft(
    principal: Principal,
    request: RequestMetadata,
    action: string,
    name: string,
  ): AuditEventDraft {
    return {
      ...auditActor(principal),
      ...request,
      action,
      resourceType: 'storage_backend',
      resourceId: name.slice(0, 500),
      details: { name: name.slice(0, 100) },
    };
  }

  /** Settings without the secret, the access key id or the CA bundle text. */
  private auditDetails(row: StorageBackendRow) {
    return {
      name: row.name,
      ...row.config,
      enabled: row.enabled,
      caBundleConfigured: row.caBundle !== null,
      secretConfigured: row.secretEncrypted !== null,
    };
  }

  /**
   * Merges the request into the stored credentials. An omitted secret keeps the stored one,
   * null clears it, and the access key id and secret must end up set or cleared together.
   */
  private storedCredentials({
    config,
    name,
    current,
    patch,
  }: {
    config: StorageBackendConfig;
    name: string;
    current: StoredCredentials | null;
    patch: Pick<StorageBackendPatchInput, 'caBundle' | 'accessKeyId' | 'secretAccessKey'>;
  }): StoredCredentials {
    const keep = <T>(value: T | undefined, stored: T | null): T | null =>
      value === undefined ? stored : value;
    const caBundle = keep(patch.caBundle, current?.caBundle ?? null);
    const accessKeyId = keep(patch.accessKeyId, current?.accessKeyId ?? null);
    let secret: Pick<StoredCredentials, 'secretEncrypted' | 'secretKeyId'> = {
      secretEncrypted: current?.secretEncrypted ?? null,
      secretKeyId: current?.secretKeyId ?? null,
    };
    if (patch.secretAccessKey === null || (patch.accessKeyId === null && !patch.secretAccessKey))
      secret = { secretEncrypted: null, secretKeyId: null };
    if (patch.secretAccessKey) {
      const key = this.options.secretKey;
      if (!key)
        throw new DomainError(
          422,
          'MMT_STORAGE_SECRET_KEYが設定されていないためsecretを保存できません',
          'storage_secret_key_missing',
        );
      const encrypted = encryptSecret({
        key,
        plaintext: patch.secretAccessKey,
        context: storageSecretContext(name),
      });
      secret = { secretEncrypted: encrypted.payload, secretKeyId: encrypted.keyId };
    }
    if (config.kind === 'filesystem' && (caBundle || accessKeyId || secret.secretEncrypted))
      throw new DomainError(
        422,
        'filesystemの保存先には認証情報とCAを設定できません',
        'invalid_storage_backend_config',
      );
    if ((accessKeyId === null) !== (secret.secretEncrypted === null))
      throw new DomainError(
        422,
        'access key idとsecret access keyは両方指定するか、両方とも空にしてください',
        'storage_credentials_incomplete',
      );
    return { caBundle, accessKeyId, ...secret };
  }
}
