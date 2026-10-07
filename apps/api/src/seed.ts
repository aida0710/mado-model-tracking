import { createArtifactStoresFromEnv } from '@mmt/platform';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { seedDemo } from './seed/demoSeed.js';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
try {
  const seeded = await seedDemo({ config, database, stores: createArtifactStoresFromEnv() });
  console.log(
    JSON.stringify({
      status: seeded.alreadySeeded ? 'already_seeded' : 'seeded',
      projectId: seeded.projectId,
    }),
  );
} finally {
  await database.end();
}
