import { pathToFileURL } from 'node:url';
import { createDatabase, transaction, type Database } from '../db/database.js';
import { listRunImageArtifacts } from '../repositories/runMediaRepository.js';
import { indexMlflowMediaArtifact } from '../services/runMediaIndexer.js';

// Each page is one short transaction, so the backfill does not hold locks on a busy server.
const BACKFILL_PAGE_SIZE = 500;

/**
 * Indexes MLflow log_image(key=, step=) files that were saved before run media existed, with the
 * same rule as the save hook. Already indexed files are kept, so running it again adds nothing.
 * Returns the number of image Artifacts examined.
 */
export async function backfillRunMedia(database: Database): Promise<number> {
  let after: { createdAt: string; id: string } | null = null;
  let examined = 0;
  for (;;) {
    const page = await listRunImageArtifacts(database, { after, limit: BACKFILL_PAGE_SIZE });
    if (page.length === 0) return examined;
    await transaction(database, async (connection) => {
      for (const artifact of page)
        await indexMlflowMediaArtifact(connection, {
          projectId: artifact.projectId,
          runId: artifact.runId,
          artifactId: artifact.id,
          path: artifact.path,
        });
    });
    examined += page.length;
    const last = page.at(-1)!;
    after = { createdAt: last.cursorCreatedAt, id: last.id };
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.MMT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('MMT_DATABASE_URL or DATABASE_URL is required');
  const database = createDatabase(databaseUrl);
  try {
    const examined = await backfillRunMedia(database);
    console.log(JSON.stringify({ event: 'run_media_backfill_complete', examinedArtifacts: examined }));
  } finally {
    await database.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
