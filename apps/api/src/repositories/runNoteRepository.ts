import { RUN_NOTE_TAG } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';

export interface LockedRunForNote {
  id: string;
  lifecycleStage: 'active' | 'deleted';
}

// Locks the Run row so a concurrent tag write through MLflow cannot overwrite the description.
export async function lockRunForNote(
  connection: Connection,
  run: { projectId: string; runId: string },
): Promise<LockedRunForNote | undefined> {
  return first<LockedRunForNote>(
    connection,
    'SELECT id,lifecycle_stage FROM runs WHERE id=$1 AND project_id=$2 FOR UPDATE',
    [run.runId, run.projectId],
  );
}

// Writes only the description key so other tags changed since the Run was read are kept.
export async function writeRunNote(
  connection: Connection,
  note: { runId: string; content: string | null },
): Promise<void> {
  if (note.content === null) {
    await connection.query('UPDATE runs SET tags=tags-$2::text WHERE id=$1', [
      note.runId,
      RUN_NOTE_TAG,
    ]);
    return;
  }
  await connection.query(
    'UPDATE runs SET tags=jsonb_set(tags,ARRAY[$2::text],to_jsonb($3::text)) WHERE id=$1',
    [note.runId, RUN_NOTE_TAG, note.content],
  );
}
