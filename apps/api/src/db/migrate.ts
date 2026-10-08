import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { first, transaction, type Database } from './database.js';

export async function migrate(database: Database): Promise<void> {
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  await transaction(database, async (connection) => {
    // Processes applying one schema serialize; isolated test schemas can migrate independently.
    await connection.query('SELECT pg_advisory_xact_lock(4182, hashtext(current_schema()))');
    await connection.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of files) {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const applied = await first<{ sha256: string }>(
        connection,
        'SELECT sha256 FROM schema_migrations WHERE name=$1',
        [name],
      );
      if (applied && applied.sha256 !== digest)
        throw new Error(`Applied migration changed: ${name}`);
      if (applied) continue;
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [
        name,
        digest,
      ]);
    }
  });
}
