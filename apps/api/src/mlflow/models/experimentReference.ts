import { first, type Connection } from '../../db/database.js';
import { notFound } from '../../domain/errors.js';

export async function modelExperimentId(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<string> {
  if (reference.id !== '0') return reference.id;
  // The official SDK uses 0 before set_experiment; each Project has a native Default Experiment.
  const experiment = await first<{ id: string }>(
    connection,
    "SELECT id FROM experiments WHERE project_id=$1 AND name='Default'",
    [reference.projectId],
  );
  if (!experiment) notFound('Default Experiment');
  return experiment.id;
}
