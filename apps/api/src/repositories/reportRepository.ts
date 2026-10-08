import type {
  Report,
  ReportBlock,
  ReportBlockSnapshot,
  ReportRevision,
  ReportRevisionSummary,
  ReportSnapshotData,
  ReportSnapshotRun,
  Run,
  RunMediaKind,
} from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { runSummarySelect } from './runListProjection.js';

interface StoredReport {
  id: string;
  projectId: string;
  title: string;
  currentRevision: number;
  createdById: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedById: string | null;
  archivedByName: string | null;
}

const reportSelect = `SELECT r.id,r.project_id,r.title,r.current_revision,
  r.created_by AS created_by_id,cu.display_name AS created_by_name,r.created_at,r.updated_at,
  r.archived_at,r.archived_by AS archived_by_id,au.display_name AS archived_by_name
  FROM reports r JOIN users cu ON cu.id=r.created_by LEFT JOIN users au ON au.id=r.archived_by`;

function toReport(stored: StoredReport): Report {
  return {
    id: stored.id,
    projectId: stored.projectId,
    title: stored.title,
    currentRevision: stored.currentRevision,
    createdBy: { id: stored.createdById, displayName: stored.createdByName },
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    archivedAt: stored.archivedAt,
    archivedBy:
      stored.archivedById === null
        ? null
        : { id: stored.archivedById, displayName: stored.archivedByName! },
  };
}

export async function findReport(
  connection: Connection,
  report: { projectId: string; reportId: string; lock?: boolean },
): Promise<Report | undefined> {
  const stored = await first<StoredReport>(
    connection,
    `${reportSelect} WHERE r.id=$1 AND r.project_id=$2 ${report.lock ? 'FOR UPDATE OF r' : ''}`,
    [report.reportId, report.projectId],
  );
  return stored && toReport(stored);
}

/** Locks the report row so it cannot be archived while a comment is written. */
export async function findReportArchiveState(
  connection: Connection,
  report: { projectId: string; reportId: string },
): Promise<{ archived: boolean } | undefined> {
  return first<{ archived: boolean }>(
    connection,
    'SELECT archived_at IS NOT NULL AS archived FROM reports WHERE id=$1 AND project_id=$2 FOR SHARE',
    [report.reportId, report.projectId],
  );
}

/** Newest first by the last change. `cursor` is the ID of the last report of the previous page. */
export async function listReports(
  connection: Connection,
  query: { projectId: string; includeArchived: boolean; cursor?: string; limit: number },
): Promise<{ items: Report[]; cursorFound: boolean }> {
  const parameters: unknown[] = [query.projectId, query.limit + 1];
  const where = ['r.project_id=$1'];
  if (!query.includeArchived) where.push('r.archived_at IS NULL');
  if (query.cursor) {
    const cursor = await first<{ id: string }>(
      connection,
      'SELECT id FROM reports WHERE id=$1 AND project_id=$2',
      [query.cursor, query.projectId],
    );
    if (!cursor) return { items: [], cursorFound: false };
    parameters.push(query.cursor);
    where.push(
      `(r.updated_at,r.id) < (SELECT updated_at,id FROM reports WHERE id=$${parameters.length})`,
    );
  }
  const stored = await rows<StoredReport>(
    connection,
    `${reportSelect} WHERE ${where.join(' AND ')} ORDER BY r.updated_at DESC,r.id DESC LIMIT $2`,
    parameters,
  );
  return { items: stored.map(toReport), cursorFound: true };
}

export async function insertReport(
  connection: Connection,
  report: { projectId: string; title: string; createdBy: string },
): Promise<string> {
  const inserted = await first<{ id: string }>(
    connection,
    `INSERT INTO reports(project_id,title,current_revision,created_by) VALUES($1,$2,1,$3) RETURNING id`,
    [report.projectId, report.title, report.createdBy],
  );
  return inserted!.id;
}

export async function updateReportHead(
  connection: Connection,
  head: { reportId: string; revision: number; title: string },
): Promise<void> {
  await connection.query(
    'UPDATE reports SET current_revision=$2,title=$3,updated_at=now() WHERE id=$1',
    [head.reportId, head.revision, head.title],
  );
}

/** archivedBy null unarchives. */
export async function updateReportArchive(
  connection: Connection,
  archive: { reportId: string; archivedBy: string | null },
): Promise<void> {
  await connection.query(
    `UPDATE reports SET archived_by=$2,archived_at=CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END,
    updated_at=now() WHERE id=$1`,
    [archive.reportId, archive.archivedBy],
  );
}

interface StoredRevision {
  reportId: string;
  revision: number;
  title: string;
  message: string | null;
  restoredFromRevision: number | null;
  createdById: string;
  createdByName: string;
  createdAt: string;
  blocks?: ReportBlock[];
}

const revisionColumns = `v.report_id,v.revision,v.title,v.message,v.restored_from_revision,
  v.created_by AS created_by_id,u.display_name AS created_by_name,v.created_at`;

function toRevisionSummary(stored: StoredRevision): ReportRevisionSummary {
  return {
    reportId: stored.reportId,
    revision: stored.revision,
    title: stored.title,
    message: stored.message,
    createdBy: { id: stored.createdById, displayName: stored.createdByName },
    createdAt: stored.createdAt,
    restoredFromRevision: stored.restoredFromRevision,
  };
}

export async function insertRevision(
  connection: Connection,
  revision: {
    reportId: string;
    revision: number;
    title: string;
    blocks: ReportBlock[];
    message: string | null;
    restoredFromRevision: number | null;
    createdBy: string;
  },
): Promise<void> {
  await connection.query(
    `INSERT INTO report_revisions(report_id,revision,title,blocks,message,restored_from_revision,created_by)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)`,
    [
      revision.reportId,
      revision.revision,
      revision.title,
      JSON.stringify(revision.blocks),
      revision.message,
      revision.restoredFromRevision,
      revision.createdBy,
    ],
  );
}

export async function findRevision(
  connection: Connection,
  revision: { reportId: string; revision: number },
): Promise<ReportRevision | undefined> {
  const stored = await first<StoredRevision>(
    connection,
    `SELECT ${revisionColumns},v.blocks FROM report_revisions v JOIN users u ON u.id=v.created_by
    WHERE v.report_id=$1 AND v.revision=$2`,
    [revision.reportId, revision.revision],
  );
  return stored && { ...toRevisionSummary(stored), blocks: stored.blocks! };
}

/** Newest first; the history is never trimmed. */
export async function listRevisions(
  connection: Connection,
  reportId: string,
): Promise<ReportRevisionSummary[]> {
  const stored = await rows<StoredRevision>(
    connection,
    `SELECT ${revisionColumns} FROM report_revisions v JOIN users u ON u.id=v.created_by
    WHERE v.report_id=$1 ORDER BY v.revision DESC`,
    [reportId],
  );
  return stored.map(toRevisionSummary);
}

export interface SnapshotRow {
  blockId: string;
  data: ReportSnapshotData;
  /** null for data captured by this save: the transaction time is stored. */
  capturedAt: string | null;
  capturedRevision: number;
  sizeBytes: number;
}

export async function insertSnapshots(
  connection: Connection,
  revision: { reportId: string; revision: number; snapshots: SnapshotRow[] },
): Promise<void> {
  if (!revision.snapshots.length) return;
  await connection.query(
    `INSERT INTO report_block_snapshots(report_id,revision,block_id,data,captured_at,captured_revision,size_bytes)
    SELECT $1,$2,s.block_id,s.data,COALESCE(s.captured_at,now()),s.captured_revision,s.size_bytes
    FROM jsonb_to_recordset($3::jsonb)
      AS s(block_id text,data jsonb,captured_at timestamptz,captured_revision integer,size_bytes integer)`,
    [
      revision.reportId,
      revision.revision,
      JSON.stringify(
        revision.snapshots.map((snapshot) => ({
          block_id: snapshot.blockId,
          data: snapshot.data,
          captured_at: snapshot.capturedAt,
          captured_revision: snapshot.capturedRevision,
          size_bytes: snapshot.sizeBytes,
        })),
      ),
    ],
  );
}

export async function listSnapshots(
  connection: Connection,
  revision: { reportId: string; revision: number },
): Promise<ReportBlockSnapshot[]> {
  return rows<ReportBlockSnapshot>(
    connection,
    `SELECT block_id,captured_revision,captured_at,size_bytes,data FROM report_block_snapshots
    WHERE report_id=$1 AND revision=$2 ORDER BY block_id`,
    [revision.reportId, revision.revision],
  );
}

// Tables a report may refer to by ID; each has project_id.
export type ReportReferenceTable = 'runs' | 'sweeps' | 'experiments' | 'model_versions' | 'dataset_versions';

export async function countProjectRows(
  connection: Connection,
  reference: { table: ReportReferenceTable; projectId: string; ids: string[] },
): Promise<number> {
  if (!reference.ids.length) return 0;
  const found = await first<{ count: number }>(
    connection,
    `SELECT count(*)::int AS count FROM ${reference.table} WHERE project_id=$1 AND id=ANY($2::uuid[])`,
    [reference.projectId, reference.ids],
  );
  return found!.count;
}

export async function findSavedViewVisibilities(
  connection: Connection,
  views: { projectId: string; savedViewIds: string[] },
): Promise<{ id: string; visibility: 'private' | 'project' }[]> {
  if (!views.savedViewIds.length) return [];
  return rows(
    connection,
    'SELECT id,visibility FROM saved_views WHERE project_id=$1 AND id=ANY($2::uuid[])',
    [views.projectId, views.savedViewIds],
  );
}

/** The kind of a run_media row of the Run; undefined when there is none. */
export async function findRunMediaKind(
  connection: Connection,
  media: { projectId: string; runId: string; mediaId: string },
): Promise<RunMediaKind | undefined> {
  const found = await first<{ kind: RunMediaKind }>(
    connection,
    'SELECT kind FROM run_media WHERE id=$1 AND run_id=$2 AND project_id=$3',
    [media.mediaId, media.runId, media.projectId],
  );
  return found?.kind;
}

/** Trial Runs of a sweep whose Run is active, in trial order (as the analysis API reads them). */
export async function listSweepTrialRunIds(
  connection: Connection,
  sweep: { projectId: string; sweepId: string },
): Promise<string[]> {
  const found = await rows<{ runId: string }>(
    connection,
    `SELECT t.run_id FROM sweep_trials t JOIN runs r ON r.id=t.run_id
    WHERE t.sweep_id=$1 AND t.project_id=$2 AND r.lifecycle_stage='active' ORDER BY t.trial_index`,
    [sweep.sweepId, sweep.projectId],
  );
  return found.map((trial) => trial.runId);
}

/** Run summaries in the given order; Runs of other Projects are left out. */
export async function readRunSummaries(
  connection: Connection,
  runs: { projectId: string; runIds: string[] },
): Promise<Run[]> {
  if (!runs.runIds.length) return [];
  const found = await rows<Run>(
    connection,
    `${runSummarySelect} WHERE project_id=$1 AND id=ANY($2::uuid[])`,
    [runs.projectId, runs.runIds],
  );
  const byId = new Map(found.map((run) => [run.id, run]));
  return runs.runIds.flatMap((id) => byId.get(id) ?? []);
}

export async function readRunNames(
  connection: Connection,
  runs: { projectId: string; runIds: string[] },
): Promise<ReportSnapshotRun[]> {
  if (!runs.runIds.length) return [];
  const found = await rows<{ id: string; name: string }>(
    connection,
    'SELECT id,name FROM runs WHERE project_id=$1 AND id=ANY($2::uuid[])',
    [runs.projectId, runs.runIds],
  );
  const byId = new Map(found.map((run) => [run.id, run.name]));
  return runs.runIds.flatMap((runId) =>
    byId.has(runId) ? [{ runId, name: byId.get(runId)! }] : [],
  );
}
