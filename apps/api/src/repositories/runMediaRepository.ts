import type {
  ArtifactMediaInfo,
  JsonObject,
  RunMedia,
  RunMediaKeySummary,
  RunMediaKind,
  RunMediaSource,
} from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { currentRunArtifactCondition } from '../services/artifactListing.js';

/** A run_media row with the facts of its Artifact; RunMedia without the derived URLs. */
export interface RunMediaRecord {
  id: string;
  projectId: string;
  runId: string;
  key: string;
  step: number;
  kind: RunMediaKind;
  artifactId: string;
  thumbnailArtifactId: string | null;
  caption: string | null;
  metadata: JsonObject;
  source: RunMediaSource;
  path: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface RunMediaInsert {
  id: string;
  projectId: string;
  runId: string;
  key: string;
  step: number;
  kind: RunMediaKind;
  artifactId: string;
  caption: string | null;
  metadata: JsonObject;
}

interface ListCursor {
  step: string;
  key: string;
  createdAt: string;
  id: string;
}

// to_char keeps microseconds so the keyset is exact; a JavaScript Date would round them.
const CURSOR_TIMESTAMP_SQL = `to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECORD_SELECT = `SELECT m.id,m.project_id,m.run_id,m.key,m.step::text AS step,m.kind,m.artifact_id,
  m.thumbnail_artifact_id,m.caption,m.metadata,m.source,a.path,a.mime_type,a.size,m.created_at,
  ${CURSOR_TIMESTAMP_SQL} AS cursor_created_at
  FROM run_media m JOIN artifacts a ON a.id=m.artifact_id AND a.project_id=m.project_id`;

/**
 * MLflow rows follow the file the Run currently shows at the path, as the artifact list does, so
 * re-uploading an image path replaces the item instead of adding a second one.
 */
const VISIBLE_CONDITION = `(m.source='native' OR ${currentRunArtifactCondition('a')})`;

type RecordRow = Omit<RunMediaRecord, 'step'> & { step: string; cursorCreatedAt: string };

function toRecord({ cursorCreatedAt: _cursor, ...row }: RecordRow): RunMediaRecord {
  return { ...row, step: Number(row.step) };
}

function invalidCursor(): never {
  throw new DomainError(400, 'cursorが不正です', 'invalid_cursor');
}

function encodeCursor(row: RecordRow): string {
  const cursor: ListCursor = { step: row.step, key: row.key, createdAt: row.cursorCreatedAt, id: row.id };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(token: string): ListCursor {
  let cursor: Partial<ListCursor>;
  try {
    cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<ListCursor>;
  } catch {
    invalidCursor();
  }
  if (
    typeof cursor !== 'object' ||
    cursor === null ||
    typeof cursor.step !== 'string' ||
    !/^\d{1,19}$/.test(cursor.step) ||
    typeof cursor.key !== 'string' ||
    typeof cursor.createdAt !== 'string' ||
    !CURSOR_TIMESTAMP_PATTERN.test(cursor.createdAt) ||
    typeof cursor.id !== 'string' ||
    !UUID_PATTERN.test(cursor.id)
  )
    invalidCursor();
  return cursor as ListCursor;
}

export async function findRunMediaByIds(
  connection: Connection,
  ids: readonly string[],
): Promise<RunMediaRecord[]> {
  const found = await rows<RecordRow>(connection, `${RECORD_SELECT} WHERE m.id=ANY($1::uuid[])`, [ids]);
  return found.map(toRecord);
}

export async function findRunMedia(
  connection: Connection,
  reference: { projectId: string; runId: string; id: string },
): Promise<RunMediaRecord | undefined> {
  const found = await first<RecordRow>(
    connection,
    `${RECORD_SELECT} WHERE m.project_id=$1 AND m.run_id=$2 AND m.id=$3`,
    [reference.projectId, reference.runId, reference.id],
  );
  return found && toRecord(found);
}

/** Items of the Run that already hold one of the (key, step, artifactId) triples. */
export async function findRunMediaTriples(
  connection: Connection,
  query: { runId: string; items: readonly { key: string; step: number; artifactId: string }[] },
): Promise<{ id: string; key: string; step: number; artifactId: string }[]> {
  const found = await rows<{ id: string; key: string; step: string; artifactId: string }>(
    connection,
    `SELECT m.id,m.key,m.step::text AS step,m.artifact_id FROM run_media m
     JOIN unnest($2::text[],$3::bigint[],$4::uuid[]) AS item(key,step,artifact_id)
       ON item.key=m.key AND item.step=m.step AND item.artifact_id=m.artifact_id
     WHERE m.run_id=$1`,
    [
      query.runId,
      query.items.map((item) => item.key),
      query.items.map((item) => item.step),
      query.items.map((item) => item.artifactId),
    ],
  );
  return found.map((row) => ({ ...row, step: Number(row.step) }));
}

export async function insertRunMedia(
  connection: Connection,
  items: readonly RunMediaInsert[],
): Promise<void> {
  await connection.query(
    `INSERT INTO run_media(id,project_id,run_id,key,step,kind,artifact_id,caption,metadata,source)
     SELECT item.id,item.project_id,item.run_id,item.key,item.step,item.kind,item.artifact_id,
       item.caption,item.metadata,'native'
     FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::text[],$5::bigint[],$6::text[],$7::uuid[],
       $8::text[],$9::jsonb[]) AS item(id,project_id,run_id,key,step,kind,artifact_id,caption,metadata)`,
    [
      items.map((item) => item.id),
      items.map((item) => item.projectId),
      items.map((item) => item.runId),
      items.map((item) => item.key),
      items.map((item) => item.step),
      items.map((item) => item.kind),
      items.map((item) => item.artifactId),
      items.map((item) => item.caption),
      items.map((item) => JSON.stringify(item.metadata)),
    ],
  );
}

export interface RunMediaPageQuery {
  projectId: string;
  runId: string;
  key?: string;
  kind?: RunMediaKind;
  stepFrom?: number;
  stepTo?: number;
  cursor?: string;
  limit: number;
}

/** Step order; within a step by key, then oldest first. */
export async function listRunMediaPage(
  connection: Connection,
  query: RunMediaPageQuery,
): Promise<{ items: RunMediaRecord[]; nextCursor?: string }> {
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const listed = await rows<RecordRow>(
    connection,
    `${RECORD_SELECT}
     WHERE m.project_id=$1 AND m.run_id=$2 AND ${VISIBLE_CONDITION}
       AND ($3::text IS NULL OR m.key=$3) AND ($4::text IS NULL OR m.kind=$4)
       AND ($5::bigint IS NULL OR m.step>=$5) AND ($6::bigint IS NULL OR m.step<=$6)
       AND ($7::bigint IS NULL OR (m.step,m.key COLLATE "C",m.created_at,m.id)
            > ($7::bigint,$8::text COLLATE "C",$9::timestamptz,$10::uuid))
     ORDER BY m.step,m.key COLLATE "C",m.created_at,m.id LIMIT $11`,
    [
      query.projectId,
      query.runId,
      query.key ?? null,
      query.kind ?? null,
      query.stepFrom ?? null,
      query.stepTo ?? null,
      after?.step ?? null,
      after?.key ?? null,
      after?.createdAt ?? null,
      after?.id ?? null,
      query.limit + 1,
    ],
  );
  const page = listed.slice(0, query.limit);
  return listed.length > query.limit
    ? { items: page.map(toRecord), nextCursor: encodeCursor(page.at(-1)!) }
    : { items: page.map(toRecord) };
}

export async function listRunMediaKeys(
  connection: Connection,
  reference: { projectId: string; runId: string },
): Promise<RunMediaKeySummary[]> {
  const summaries = await rows<{ key: string; kind: RunMediaKind; count: string; minStep: string; maxStep: string }>(
    connection,
    `SELECT m.key,m.kind,count(*) AS count,min(m.step)::text AS min_step,max(m.step)::text AS max_step
     FROM run_media m JOIN artifacts a ON a.id=m.artifact_id AND a.project_id=m.project_id
     WHERE m.project_id=$1 AND m.run_id=$2 AND ${VISIBLE_CONDITION}
     GROUP BY m.key,m.kind ORDER BY m.key COLLATE "C",m.kind`,
    [reference.projectId, reference.runId],
  );
  return summaries.map((summary) => ({
    key: summary.key,
    kind: summary.kind,
    count: Number(summary.count),
    minStep: Number(summary.minStep),
    maxStep: Number(summary.maxStep),
  }));
}

/**
 * The media of key for each Run at the given steps, or at each Run's latest step for the key when
 * steps is null. Ordered by Run, step, then oldest first.
 */
export async function listComparedMedia(
  connection: Connection,
  query: { projectId: string; runIds: string[]; key: string; kind?: RunMediaKind; steps: number[] | null },
): Promise<RunMediaRecord[]> {
  const listed = await rows<RecordRow>(
    connection,
    `WITH visible AS (
       ${RECORD_SELECT}
       WHERE m.project_id=$1 AND m.run_id=ANY($2::uuid[]) AND m.key=$3
         AND ($4::text IS NULL OR m.kind=$4) AND ${VISIBLE_CONDITION}
     )
     -- RECORD_SELECT returns step as text (bigint beyond 2^53 stays exact), so compare it as bigint.
     SELECT * FROM visible v
     WHERE CASE WHEN $5::bigint[] IS NULL
       THEN v.step::bigint=(SELECT max(latest.step::bigint) FROM visible latest WHERE latest.run_id=v.run_id)
       ELSE v.step::bigint=ANY($5::bigint[]) END
     ORDER BY v.run_id,v.step::bigint,v.created_at,v.id`,
    [query.projectId, query.runIds, query.key, query.kind ?? null, query.steps],
  );
  return listed.map(toRecord);
}

export async function listMediaInfo(
  connection: Connection,
  reference: { projectId: string; artifactIds: readonly string[] },
): Promise<ArtifactMediaInfo[]> {
  if (reference.artifactIds.length === 0) return [];
  return rows<ArtifactMediaInfo>(
    connection,
    `SELECT artifact_id,duration_seconds,sample_rate,channels,bits_per_sample,codec,source
     FROM artifact_media_info WHERE project_id=$1 AND artifact_id=ANY($2::uuid[])`,
    [reference.projectId, [...new Set(reference.artifactIds)]],
  );
}

/** Artifacts of the Project by id, for checking what a create request refers to. */
export async function findProjectArtifacts(
  connection: Connection,
  reference: { projectId: string; ids: readonly string[] },
): Promise<{ id: string; runId: string | null; path: string; mimeType: string; size: number }[]> {
  return rows(
    connection,
    'SELECT id,run_id,path,mime_type,size FROM artifacts WHERE project_id=$1 AND id=ANY($2::uuid[])',
    [reference.projectId, [...new Set(reference.ids)]],
  );
}

export interface CurrentRunArtifact {
  id: string;
  runId: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

/**
 * The Artifact each Run currently shows at each path (the MLflow path mapping, else the newest
 * upload), limited to Runs of the Project. Missing paths are absent from the result.
 */
export async function findCurrentRunArtifacts(
  connection: Connection,
  query: { projectId: string; files: readonly { runId: string; path: string }[] },
): Promise<CurrentRunArtifact[]> {
  if (query.files.length === 0) return [];
  return rows<CurrentRunArtifact>(
    connection,
    `SELECT a.id,a.run_id,a.path,a.mime_type,a.size,a.created_at FROM artifacts a
     JOIN (SELECT DISTINCT * FROM unnest($2::uuid[],$3::text[]) AS file(run_id,path)) file
       ON file.run_id=a.run_id AND file.path=a.path
     WHERE a.project_id=$1 AND ${currentRunArtifactCondition('a')}`,
    [query.projectId, query.files.map((file) => file.runId), query.files.map((file) => file.path)],
  );
}

/** Artifact ids among ids that a run_media row already describes. */
export async function findIndexedArtifactIds(
  connection: Connection,
  artifactIds: readonly string[],
): Promise<Set<string>> {
  if (artifactIds.length === 0) return new Set();
  const found = await rows<{ artifactId: string }>(
    connection,
    'SELECT DISTINCT artifact_id FROM run_media WHERE artifact_id=ANY($1::uuid[])',
    [[...artifactIds]],
  );
  return new Set(found.map((row) => row.artifactId));
}

/** Inserts the image row of an MLflow log_image call; a repeated call keeps the existing row. */
export async function insertMlflowImage(
  connection: Connection,
  image: {
    projectId: string;
    runId: string;
    key: string;
    step: number;
    artifactId: string;
    thumbnailArtifactId: string | null;
    metadata: JsonObject;
  },
): Promise<void> {
  await connection.query(
    `INSERT INTO run_media(id,project_id,run_id,key,step,kind,artifact_id,thumbnail_artifact_id,metadata,source)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,'image',$5,$6,$7,'mlflow')
     ON CONFLICT (run_id,key,step,artifact_id) DO NOTHING`,
    [
      image.projectId,
      image.runId,
      image.key,
      image.step,
      image.artifactId,
      image.thumbnailArtifactId,
      JSON.stringify(image.metadata),
    ],
  );
}

/** Attaches a thumbnail to the MLflow image rows of the image Artifact at imagePath in the Run. */
export async function attachMlflowThumbnail(
  connection: Connection,
  thumbnail: { projectId: string; runId: string; imagePath: string; thumbnailArtifactId: string },
): Promise<void> {
  await connection.query(
    `UPDATE run_media m SET thumbnail_artifact_id=$4 FROM artifacts a
     WHERE a.id=m.artifact_id AND a.project_id=m.project_id AND m.project_id=$1 AND m.run_id=$2
       AND m.source='mlflow' AND a.path=$3`,
    [thumbnail.projectId, thumbnail.runId, thumbnail.imagePath, thumbnail.thumbnailArtifactId],
  );
}

/** Run artifacts under images/ in creation order, for indexing files saved before this feature. */
export async function listRunImageArtifacts(
  connection: Connection,
  page: { after: { createdAt: string; id: string } | null; limit: number },
): Promise<{ id: string; projectId: string; runId: string; path: string; createdAt: string; cursorCreatedAt: string }[]> {
  return rows(
    connection,
    `SELECT a.id,a.project_id,a.run_id,a.path,a.created_at,
       to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
     FROM artifacts a
     WHERE a.run_id IS NOT NULL AND a.path COLLATE "C" LIKE 'images/%'
       AND ($1::timestamptz IS NULL OR (a.created_at,a.id)>($1::timestamptz,$2::uuid))
     ORDER BY a.created_at,a.id LIMIT $3`,
    [page.after?.createdAt ?? null, page.after?.id ?? null, page.limit],
  );
}

/** The tags of the Project's Runs among runIds; Runs of other Projects are absent. */
export async function findRunTags(
  connection: Connection,
  query: { projectId: string; runIds: readonly string[] },
): Promise<{ id: string; tags: Record<string, string> }[]> {
  return rows(connection, 'SELECT id,tags FROM runs WHERE project_id=$1 AND id=ANY($2::uuid[])', [
    query.projectId,
    [...query.runIds],
  ]);
}
