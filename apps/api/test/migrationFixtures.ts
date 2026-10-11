import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';

const MIGRATIONS = new URL('../src/db/migrations/', import.meta.url);

/**
 * Applies the migrations that sort before `firstPending` and records them as migrate() does, so a
 * test can insert rows of the older schema and then let migrate() apply the rest. The harness must
 * be created with applyMigrations: false.
 */
export async function applyMigrationsBefore(
  database: pg.Pool,
  firstPending: string,
): Promise<void> {
  await database.query(
    'CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const earlier = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith('.sql') && name < firstPending)
    .sort();
  for (const name of earlier) {
    const sql = await readFile(new URL(name, MIGRATIONS), 'utf8');
    await database.query(sql);
    await database.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [
      name,
      createHash('sha256').update(sql).digest('hex'),
    ]);
  }
}
