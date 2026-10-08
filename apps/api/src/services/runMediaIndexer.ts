import type { Connection } from '../db/database.js';
import { parseMlflowImagePath } from '../domain/mlflowMediaPaths.js';
import {
  attachMlflowThumbnail,
  findCurrentRunArtifacts,
  insertMlflowImage,
} from '../repositories/runMediaRepository.js';

const INDEX_SAVEPOINT = 'run_media_index';

export interface SavedRunArtifact {
  projectId: string;
  runId: string;
  artifactId: string;
  /** The path inside the Run's artifact root. */
  path: string;
}

/**
 * Indexes an MLflow log_image(key=, step=) file as run media, inside the transaction that
 * registers the Artifact. The compressed .webp becomes the thumbnail of the image row, whichever
 * of the two files arrives first. The index is a convenience, so a failure is rolled back to a
 * savepoint and logged instead of failing the Artifact save.
 */
export async function indexMlflowMediaArtifact(
  connection: Connection,
  saved: SavedRunArtifact,
): Promise<void> {
  const image = parseMlflowImagePath(saved.path);
  if (!image) return;
  await connection.query(`SAVEPOINT ${INDEX_SAVEPOINT}`);
  try {
    if (image.compressed)
      await attachMlflowThumbnail(connection, {
        projectId: saved.projectId,
        runId: saved.runId,
        imagePath: image.imagePath,
        thumbnailArtifactId: saved.artifactId,
      });
    else {
      const [thumbnail] = await findCurrentRunArtifacts(connection, {
        projectId: saved.projectId,
        files: [{ runId: saved.runId, path: image.compressedPath }],
      });
      await insertMlflowImage(connection, {
        projectId: saved.projectId,
        runId: saved.runId,
        key: image.key,
        step: image.step,
        artifactId: saved.artifactId,
        thumbnailArtifactId: thumbnail?.id ?? null,
        metadata: { timestamp: image.timestamp },
      });
    }
    await connection.query(`RELEASE SAVEPOINT ${INDEX_SAVEPOINT}`);
  } catch (error) {
    await connection.query(`ROLLBACK TO SAVEPOINT ${INDEX_SAVEPOINT}`);
    // SQL details are not logged; the Artifact id identifies the file to index again by backfill.
    console.error(
      JSON.stringify({
        event: 'run_media_index_failed',
        artifactId: saved.artifactId,
        projectId: saved.projectId,
        name: (error as Error).name,
      }),
    );
  }
}
