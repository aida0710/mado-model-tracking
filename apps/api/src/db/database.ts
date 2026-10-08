import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';

export type Database = pg.Pool;
export type Connection = Database | PoolClient;

// Leave room for the web API and outbox while bounding connections on the development DB.
const DATABASE_POOL_SIZE = 12;
// Return a visible failure promptly when PostgreSQL is unavailable.
const DATABASE_CONNECTION_TIMEOUT_MS = 5000;
// Release idle API connections instead of occupying the DB pool indefinitely.
const DATABASE_IDLE_TIMEOUT_MS = 30000;

export function createDatabase(databaseUrl: string): Database {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: DATABASE_POOL_SIZE,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MS,
  });
}

export async function transaction<T>(
  database: Database,
  operation: (connection: PoolClient) => Promise<T>,
): Promise<T> {
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    const value = await operation(connection);
    await connection.query('COMMIT');
    return value;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

function mapColumns<T>(row: QueryResultRow): T {
  const entity: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    const property = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    // JSON values keep their original keys; only SQL columns are mapped. bigint columns arrive
    // as strings; a NULL one (total_size of a reference DatasetVersion) stays null.
    entity[property] =
      value instanceof Date
        ? value.toISOString()
        : ['size', 'run_count', 'total_size'].includes(column) && value !== null
          ? Number(value)
          : value;
  }
  return entity as T;
}

export async function rows<T>(
  connection: Connection,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<T[]> {
  const response = await connection.query(sql, [...parameters]);
  return response.rows.map((row) => mapColumns<T>(row));
}

export async function first<T>(
  connection: Connection,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<T | undefined> {
  return (await rows<T>(connection, sql, parameters))[0];
}
