import { createDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';

const databaseUrl = process.env.MMT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('MMT_DATABASE_URL or DATABASE_URL is required');
const database = createDatabase(databaseUrl);
try {
  await migrate(database);
  console.log('Migration complete');
} finally {
  await database.end();
}
