import { first, type Connection } from '../db/database.js';
import { conflict, notFound } from '../domain/errors.js';
import { MAX_MODEL_VERSION_DIGITS, MAX_NUMERIC_MODEL_VERSION } from '../mlflow/models/limits.js';

// Versions such as "v1" or numbers wider than the bigint counter stay valid but are not numbered.
const NUMBERED_VERSION_PATTERN = new RegExp(`^[0-9]{1,${MAX_MODEL_VERSION_DIGITS}}$`);

function isNumberedVersion(version: string): boolean {
  return NUMBERED_VERSION_PATTERN.test(version);
}

/**
 * Locks the Model row and decides the version to insert.
 * An omitted version takes models.next_version; an explicit integer version moves the
 * counter past itself so later automatic numbers never collide or reuse deleted numbers.
 * The caller must insert the version in the same transaction that holds the lock.
 */
export async function reserveModelVersion(
  connection: Connection,
  reservation: { projectId: string; modelId: string; version?: string },
): Promise<string> {
  const model = await first<{ nextVersion: string }>(
    connection,
    'SELECT next_version::text AS next_version FROM models WHERE id=$1 AND project_id=$2 FOR UPDATE',
    [reservation.modelId, reservation.projectId],
  );
  if (!model) notFound('Model');
  const requested = reservation.version;
  if (requested !== undefined) {
    if (isNumberedVersion(requested))
      await connection.query(
        'UPDATE models SET next_version=GREATEST(next_version,$2::bigint+1) WHERE id=$1',
        [reservation.modelId, requested],
      );
    return requested;
  }
  if (BigInt(model.nextVersion) > MAX_NUMERIC_MODEL_VERSION)
    conflict('モデルバージョンの採番上限に達しました');
  await connection.query('UPDATE models SET next_version=next_version+1 WHERE id=$1', [
    reservation.modelId,
  ]);
  return model.nextVersion;
}
