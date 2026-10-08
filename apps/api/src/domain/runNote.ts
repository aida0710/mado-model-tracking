import { z } from 'zod';
import { RUN_NOTE_MAX_LENGTH } from '@mmt/contracts';

// Counted in UTF-16 code units like the MLflow set-tag validator, so both paths accept the same notes.
export const runNoteUpdateSchema = z.strictObject({
  content: z.string().max(RUN_NOTE_MAX_LENGTH),
});

/** An empty description removes the tag instead of storing an empty string. */
export function storedRunNote(content: string): string | null {
  return content === '' ? null : content;
}
