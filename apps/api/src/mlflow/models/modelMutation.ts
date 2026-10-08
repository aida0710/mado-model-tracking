import type { PoolClient } from 'pg';
import type { Principal } from '../../auth/principal.js';
import { transaction, type Database } from '../../db/database.js';
import { requireModelsWrite } from './access.js';
import { findLoggedModel, findRegisteredModel } from './modelRepository.js';
import type { LoggedModelRecord, RegisteredModelRecord } from './types.js';

export function mutateRegisteredModel<T>(
  database: Database,
  access: { principal: Principal; projectId: string; name: string },
  mutate: (connection: PoolClient, model: RegisteredModelRecord) => Promise<T>,
): Promise<T> {
  return transaction(database, async (connection) => {
    await requireModelsWrite(connection, access);
    await findRegisteredModel(connection, {
      projectId: access.projectId,
      name: access.name,
      lock: true,
    });
    // A waiter must reread supplemental lifecycle metadata after the native Model lock.
    // The delete transaction can update metadata without changing the locked native tuple.
    await requireModelsWrite(connection, access);
    const model = await findRegisteredModel(connection, {
      projectId: access.projectId,
      name: access.name,
    });
    return mutate(connection, model);
  });
}

export function mutateLoggedModel<T>(
  database: Database,
  access: { principal: Principal; projectId: string; id: string },
  mutate: (connection: PoolClient, model: LoggedModelRecord) => Promise<T>,
): Promise<T> {
  return transaction(database, async (connection) => {
    await requireModelsWrite(connection, access);
    const model = await findLoggedModel(connection, {
      projectId: access.projectId,
      id: access.id,
      lock: true,
    });
    return mutate(connection, model);
  });
}
