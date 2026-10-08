import type {
  JsonObject,
  RunCheckpoint,
  RunCheckpointArtifact,
  RunCheckpointManifest,
  RunCheckpointSource,
  RunKind,
  RunResumeCheckpointRecord,
} from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { parseMlflowCheckpointPath } from '../domain/checkpointValidation.js';
import { notFound } from '../domain/errors.js';

interface RunCheckpointRow extends Omit<RunCheckpoint, 'artifacts'> {
  artifacts: RunCheckpointArtifact[];
}

/** A saved Artifact as the checkpoint checks it; path is the Run artifact path. */
export interface SavedArtifact {
  id: string;
  runId: string | null;
  path: string;
  size: number;
  sha256: string;
}

// bigint step and summed sizes are read as float8 so they map to JSON numbers.
const checkpointSelect = `SELECT c.id,c.project_id,c.run_id,c.step::float8 AS step,c.source,c.artifact_ids,
  c.manifest,c.metadata,c.retained,c.created_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'path',a.path,'size',a.size,'sha256',a.sha256)
    ORDER BY a.path COLLATE "C") FROM artifacts a WHERE a.id=ANY(c.artifact_ids) AND a.project_id=c.project_id),
    '[]'::jsonb) AS artifacts,
  (SELECT COALESCE(sum(a.size),0)::float8 FROM artifacts a
    WHERE a.id=ANY(c.artifact_ids) AND a.project_id=c.project_id) AS total_size
  FROM run_checkpoints c`;

/** An MLflow checkpoint's Artifacts are listed by their path inside step-<N>/, like its manifest. */
function toCheckpoint(row: RunCheckpointRow): RunCheckpoint {
  if (row.source !== 'mlflow') return row;
  return {
    ...row,
    artifacts: row.artifacts.map((artifact) => ({
      ...artifact,
      path: parseMlflowCheckpointPath(artifact.path)?.relativePath ?? artifact.path,
    })),
  };
}

export async function listRunCheckpoints(
  connection: Connection,
  query: { projectId: string; runId: string; includeHidden: boolean },
): Promise<RunCheckpoint[]> {
  const found = await rows<RunCheckpointRow>(
    connection,
    `${checkpointSelect} WHERE c.project_id=$1 AND c.run_id=$2 AND ($3 OR c.retained)
    ORDER BY c.step DESC`,
    [query.projectId, query.runId, query.includeHidden],
  );
  return found.map(toCheckpoint);
}

export async function findCheckpoint(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<RunCheckpoint> {
  const found = await first<RunCheckpointRow>(
    connection,
    `${checkpointSelect} WHERE c.project_id=$1 AND c.id=$2`,
    [reference.projectId, reference.id],
  );
  if (!found) notFound('Checkpoint');
  return toCheckpoint(found);
}

/** The largest step, hidden or not: hiding only trims the list, the files stay usable. */
export async function findLatestCheckpointId(
  connection: Connection,
  reference: { projectId: string; runId: string },
): Promise<string | null> {
  const found = await first<{ id: string }>(
    connection,
    'SELECT id FROM run_checkpoints WHERE project_id=$1 AND run_id=$2 ORDER BY step DESC LIMIT 1',
    [reference.projectId, reference.runId],
  );
  return found?.id ?? null;
}

export async function findMlflowCheckpointForUpdate(
  connection: Connection,
  reference: { projectId: string; runId: string; step: number },
): Promise<{ id: string; artifactIds: string[]; manifest: RunCheckpointManifest; final: boolean } | null> {
  return (
    (await first(
      connection,
      `SELECT id,artifact_ids,manifest,run_checkpoint_is_final(run_id,created_at) AS final
      FROM run_checkpoints WHERE project_id=$1 AND run_id=$2 AND step=$3 AND source='mlflow' FOR UPDATE`,
      [reference.projectId, reference.runId, reference.step],
    )) ?? null
  );
}

export async function checkpointStepExists(
  connection: Connection,
  reference: { runId: string; step: number },
): Promise<boolean> {
  return !!(await first(connection, 'SELECT 1 FROM run_checkpoints WHERE run_id=$1 AND step=$2', [
    reference.runId,
    reference.step,
  ]));
}

export async function insertCheckpoint(
  connection: Connection,
  checkpoint: {
    projectId: string;
    runId: string;
    step: number;
    source: RunCheckpointSource;
    artifactIds: string[];
    manifest: RunCheckpointManifest;
    metadata: JsonObject;
  },
): Promise<string> {
  const inserted = await first<{ id: string }>(
    connection,
    `INSERT INTO run_checkpoints(project_id,run_id,step,source,artifact_ids,manifest,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      checkpoint.projectId,
      checkpoint.runId,
      checkpoint.step,
      checkpoint.source,
      checkpoint.artifactIds,
      JSON.stringify(checkpoint.manifest),
      JSON.stringify(checkpoint.metadata),
    ],
  );
  return inserted!.id;
}

export async function updateMlflowCheckpointFiles(
  connection: Connection,
  update: { id: string; artifactIds: string[]; manifest: RunCheckpointManifest },
): Promise<void> {
  await connection.query('UPDATE run_checkpoints SET artifact_ids=$2,manifest=$3 WHERE id=$1', [
    update.id,
    update.artifactIds,
    JSON.stringify(update.manifest),
  ]);
}

/** Hides every checkpoint of the Run below the keepCount largest steps. */
export async function hideCheckpointsBeyond(
  connection: Connection,
  retention: { runId: string; keepCount: number },
): Promise<void> {
  await connection.query(
    `UPDATE run_checkpoints SET retained=false WHERE run_id=$1 AND retained AND id NOT IN (
      SELECT id FROM run_checkpoints WHERE run_id=$1 ORDER BY step DESC LIMIT $2)`,
    [retention.runId, retention.keepCount],
  );
}

/** Saved Artifacts in the Project; an Artifact row exists only after its content is stored. */
export async function findSavedArtifacts(
  connection: Connection,
  reference: { projectId: string; ids: readonly string[] },
): Promise<SavedArtifact[]> {
  return rows<SavedArtifact>(
    connection,
    'SELECT id,run_id,path,size,sha256 FROM artifacts WHERE project_id=$1 AND id=ANY($2::uuid[])',
    [reference.projectId, reference.ids],
  );
}

/** The facts a resume compares: the Run's kind and the Code its CodeVersion belongs to. */
export async function findRunCodeLineage(
  connection: Connection,
  reference: { projectId: string; runId: string },
): Promise<{ kind: RunKind; codeId: string | null }> {
  const found = await first<{ kind: RunKind; codeId: string | null }>(
    connection,
    `SELECT r.kind,c.code_id FROM runs r
    LEFT JOIN code_versions c ON c.id=r.code_version_id AND c.project_id=r.project_id
    WHERE r.project_id=$1 AND r.id=$2`,
    [reference.projectId, reference.runId],
  );
  if (!found) notFound('Run');
  return found;
}

export async function pinRunResumeCheckpoint(
  connection: Connection,
  pin: {
    runId: string;
    checkpointId: string;
    resume: RunResumeCheckpointRecord;
    parentRunId: string;
  },
): Promise<void> {
  await connection.query(
    `UPDATE runs SET resume_checkpoint_id=$2,environment=jsonb_set(environment,'{resume}',$3::jsonb),
    parent_run_id=COALESCE(parent_run_id,$4) WHERE id=$1`,
    [pin.runId, pin.checkpointId, JSON.stringify(pin.resume), pin.parentRunId],
  );
}
