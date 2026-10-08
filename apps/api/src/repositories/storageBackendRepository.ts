import type { StorageBackendConfig } from '@mmt/platform';
import { first, rows, type Connection } from '../db/database.js';

export interface StorageBackendRow {
  name: string;
  config: StorageBackendConfig;
  caBundle: string | null;
  accessKeyId: string | null;
  secretEncrypted: Buffer | null;
  secretKeyId: string | null;
  enabled: boolean;
  revision: number;
}
export type StorageBackendValues = Omit<StorageBackendRow, 'revision'>;

const storageBackendColumns =
  'name,config,ca_bundle,access_key_id,secret_encrypted,secret_key_id,enabled,revision';

export function listStorageBackendRows(connection: Connection): Promise<StorageBackendRow[]> {
  return rows(connection, `SELECT ${storageBackendColumns} FROM storage_backends ORDER BY name`);
}

/** Locks the row when called inside a transaction, so concurrent updates apply one at a time. */
export function findStorageBackendRowForUpdate(
  connection: Connection,
  name: string,
): Promise<StorageBackendRow | undefined> {
  return first(
    connection,
    `SELECT ${storageBackendColumns} FROM storage_backends WHERE name=$1 FOR UPDATE`,
    [name],
  );
}

export function findStorageBackendRow(
  connection: Connection,
  name: string,
): Promise<StorageBackendRow | undefined> {
  return first(connection, `SELECT ${storageBackendColumns} FROM storage_backends WHERE name=$1`, [
    name,
  ]);
}

export async function insertStorageBackend(
  connection: Connection,
  values: StorageBackendValues & { createdBy: string },
): Promise<StorageBackendRow> {
  return (await first<StorageBackendRow>(
    connection,
    `INSERT INTO storage_backends(name,kind,config,ca_bundle,access_key_id,secret_encrypted,
    secret_key_id,enabled,created_by) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
    RETURNING ${storageBackendColumns}`,
    [
      values.name,
      values.config.kind,
      JSON.stringify(values.config),
      values.caBundle,
      values.accessKeyId,
      values.secretEncrypted,
      values.secretKeyId,
      values.enabled,
      values.createdBy,
    ],
  ))!;
}

export async function updateStorageBackend(
  connection: Connection,
  values: StorageBackendValues & { updatedBy: string },
): Promise<StorageBackendRow> {
  return (await first<StorageBackendRow>(
    connection,
    `UPDATE storage_backends SET kind=$2,config=$3::jsonb,ca_bundle=$4,access_key_id=$5,
    secret_encrypted=$6,secret_key_id=$7,enabled=$8,updated_by=$9,updated_at=now(),
    revision=revision+1 WHERE name=$1 RETURNING ${storageBackendColumns}`,
    [
      values.name,
      values.config.kind,
      JSON.stringify(values.config),
      values.caBundle,
      values.accessKeyId,
      values.secretEncrypted,
      values.secretKeyId,
      values.enabled,
      values.updatedBy,
    ],
  ))!;
}

/** Artifacts and upload sessions both keep the backend name to read or finish their bytes. */
export async function isStorageBackendReferenced(
  connection: Connection,
  name: string,
): Promise<boolean> {
  const reference = await first<{ referenced: boolean }>(
    connection,
    `SELECT EXISTS(SELECT 1 FROM artifacts WHERE backend=$1)
      OR EXISTS(SELECT 1 FROM artifact_uploads WHERE backend=$1) AS referenced`,
    [name],
  );
  return reference!.referenced;
}

export async function readDefaultBackend(connection: Connection): Promise<string | null> {
  const settings = await first<{ defaultBackend: string }>(
    connection,
    'SELECT default_backend FROM storage_settings',
  );
  return settings?.defaultBackend ?? null;
}

export async function writeDefaultBackend(
  connection: Connection,
  settings: { defaultBackend: string; updatedBy: string },
): Promise<void> {
  await connection.query(
    `INSERT INTO storage_settings(singleton,default_backend,updated_by) VALUES(true,$1,$2)
    ON CONFLICT (singleton) DO UPDATE SET default_backend=EXCLUDED.default_backend,
    updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [settings.defaultBackend, settings.updatedBy],
  );
}
