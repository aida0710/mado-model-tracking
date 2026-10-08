import type {
  Artifact,
  ArtifactDirectoryEntry,
  ArtifactListVersions,
  ArtifactPage,
  ArtifactTree,
} from '@mmt/contracts';
import { rows, type Connection } from '../db/database.js';
import { DomainError } from '../domain/errors.js';

// A tree level lists directories, not files; past this many the response says it was truncated.
export const MAX_TREE_DIRECTORIES = 1000;

/**
 * SQL condition that is true for the Artifact a Run currently shows at its path. An MLflow path
 * mapping stays authoritative (a later native retry does not replace it); without a mapping the
 * newest upload wins, with the id breaking created_at ties. The MLflow artifact list uses the same
 * rule, so both APIs show the same file for a path.
 */
export function currentRunArtifactCondition(artifact: string): string {
  return `COALESCE(
    (SELECT mapping.artifact_id=${artifact}.id FROM mlflow_artifact_paths mapping
     WHERE mapping.project_id=${artifact}.project_id AND mapping.owner_kind='run'
       AND mapping.owner_id=${artifact}.run_id::text AND mapping.path=${artifact}.path),
    NOT EXISTS(SELECT 1 FROM artifacts newer
     WHERE newer.project_id=${artifact}.project_id
       AND (newer.run_id=${artifact}.run_id OR (newer.run_id IS NULL AND ${artifact}.run_id IS NULL))
       AND newer.path COLLATE "C"=${artifact}.path COLLATE "C"
       AND (newer.created_at,newer.id)>(${artifact}.created_at,${artifact}.id)))`;
}

/** Run lists are in path order; versions of one path follow newest first. */
interface RunArtifactCursor {
  kind: 'run';
  path: string;
  createdAt: string;
  id: string;
}

/** The Project catalog is newest first. */
interface CatalogCursor {
  kind: 'catalog';
  createdAt: string;
  id: string;
}

type ListingCursor = RunArtifactCursor | CatalogCursor;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// to_char output below; microseconds keep the keyset exact, which a JavaScript Date would round.
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_TIMESTAMP_SQL = `to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function invalidCursor(): never {
  throw new DomainError(400, 'cursorが不正です', 'invalid_cursor');
}

function encodeCursor(cursor: ListingCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor<K extends ListingCursor['kind']>(
  token: string,
  kind: K,
): Extract<ListingCursor, { kind: K }> {
  let cursor: Partial<RunArtifactCursor> & { kind?: unknown };
  try {
    cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as typeof cursor;
  } catch {
    invalidCursor();
  }
  if (
    typeof cursor !== 'object' ||
    cursor === null ||
    cursor.kind !== kind ||
    typeof cursor.id !== 'string' ||
    !UUID_PATTERN.test(cursor.id) ||
    typeof cursor.createdAt !== 'string' ||
    !CURSOR_TIMESTAMP_PATTERN.test(cursor.createdAt) ||
    (kind === 'run' && typeof cursor.path !== 'string')
  )
    invalidCursor();
  return cursor as Extract<ListingCursor, { kind: K }>;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** LIKE pattern for paths starting with prefix; the C collation lets PostgreSQL scan it as a range. */
function startsWithPattern(prefix: string): string {
  return `${escapeLikePattern(prefix)}%`;
}

/** Tree levels are directories: '' is the root and any other prefix gets a trailing `/`. */
export function directoryPrefix(prefix: string): string {
  return prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
}

type ListedArtifact = Artifact & { listingCreatedAt: string };

function toPage(
  listed: ListedArtifact[],
  limit: number,
  cursorOf: (last: ListedArtifact) => ListingCursor,
): ArtifactPage {
  const hasMore = listed.length > limit;
  const page = listed.slice(0, limit);
  const items = page.map(({ listingCreatedAt: _cursorTimestamp, ...artifact }) => artifact);
  return hasMore ? { items, nextCursor: encodeCursor(cursorOf(page.at(-1)!)) } : { items };
}

export interface RunArtifactQuery {
  projectId: string;
  runId: string;
  /** Raw path prefix; a file name prefix is allowed, not only a directory. */
  prefix: string;
  /** Only files directly under prefix, as S3's `/` delimiter does. */
  directFilesOnly: boolean;
  versions: ArtifactListVersions;
  limit: number;
  cursor?: string;
}

export async function listRunArtifacts(
  connection: Connection,
  query: RunArtifactQuery,
): Promise<ArtifactPage> {
  const after = query.cursor ? decodeCursor(query.cursor, 'run') : null;
  const listed = await rows<ListedArtifact>(
    connection,
    `SELECT a.*,${CURSOR_TIMESTAMP_SQL} AS listing_created_at FROM artifacts a
     WHERE a.project_id=$1 AND a.run_id=$2 AND a.path COLLATE "C" LIKE $3
       AND (NOT $4::boolean OR strpos(substr(a.path,length($5)+1),'/')=0)
       AND ($6::text IS NULL OR a.path COLLATE "C">$6 COLLATE "C"
            OR (a.path=$6 AND (a.created_at,a.id)<($7::timestamptz,$8::uuid)))
       AND ($9='all' OR ${currentRunArtifactCondition('a')})
     ORDER BY a.path COLLATE "C",a.created_at DESC,a.id DESC LIMIT $10`,
    [
      query.projectId,
      query.runId,
      startsWithPattern(query.prefix),
      query.directFilesOnly,
      query.prefix,
      after?.path ?? null,
      after?.createdAt ?? null,
      after?.id ?? null,
      query.versions,
      query.limit + 1,
    ],
  );
  return toPage(listed, query.limit, (last) => ({
    kind: 'run',
    path: last.path,
    createdAt: last.listingCreatedAt,
    id: last.id,
  }));
}

export async function runArtifactTree(
  connection: Connection,
  location: { projectId: string; runId: string; prefix: string },
): Promise<ArtifactTree> {
  const prefix = directoryPrefix(location.prefix);
  // Direct files group under '' and each subdirectory under its first path segment.
  const groups = await rows<ArtifactTreeGroup>(
    connection,
    `SELECT child,count(*) AS file_count,sum(size) AS total_size FROM (
       SELECT a.size,CASE WHEN strpos(substr(a.path,length($4)+1),'/')=0 THEN ''
                     ELSE split_part(substr(a.path,length($4)+1),'/',1) END AS child
       FROM artifacts a
       WHERE a.project_id=$1 AND a.run_id=$2 AND a.path COLLATE "C" LIKE $3
         AND ${currentRunArtifactCondition('a')}
     ) listed GROUP BY child ORDER BY child COLLATE "C" LIMIT $5`,
    [
      location.projectId,
      location.runId,
      startsWithPattern(prefix),
      prefix,
      MAX_TREE_DIRECTORIES + 2,
    ],
  );
  return artifactTreeFromGroups(prefix, groups);
}

/** A row per child of a tree level: '' for the files directly in it, else a directory name. */
export interface ArtifactTreeGroup {
  child: string;
  fileCount: string;
  totalSize: string;
}

/**
 * Builds a tree level from groups in child order, fetched with a limit of MAX_TREE_DIRECTORIES + 2
 * (the direct files plus one directory more than shown, to tell that the list was truncated).
 * Dataset versions list their files with the same shape.
 */
export function artifactTreeFromGroups(prefix: string, groups: ArtifactTreeGroup[]): ArtifactTree {
  const files = groups.find((group) => group.child === '');
  const directories: ArtifactDirectoryEntry[] = groups
    .filter((group) => group.child !== '')
    .map((group) => ({
      prefix: `${prefix}${group.child}/`,
      fileCount: Number(group.fileCount),
      totalSize: Number(group.totalSize),
    }));
  return {
    prefix,
    directories: directories.slice(0, MAX_TREE_DIRECTORIES),
    directoriesTruncated: directories.length > MAX_TREE_DIRECTORIES,
    fileCount: Number(files?.fileCount ?? 0),
    totalSize: Number(files?.totalSize ?? 0),
  };
}

export interface ProjectArtifactQuery {
  projectId: string;
  limit: number;
  /** Substring of the path. */
  query?: string;
  /** `type/subtype`, or `type/*` for every subtype. */
  mimeType?: string;
  runId?: string;
  /**
   * The version's registered Artifact and the outputs of Runs that used the version
   * (inference and evaluation Runs record it as their modelVersionId).
   */
  modelVersionId?: string;
  versions: ArtifactListVersions;
  cursor?: string;
}

/** Compared against the stored type without parameters such as `; charset=utf-8`. */
function mimeTypePattern(mimeType: string): string {
  const essence = mimeType.toLowerCase();
  return essence.endsWith('/*')
    ? startsWithPattern(essence.slice(0, -1))
    : escapeLikePattern(essence);
}

export async function listProjectArtifacts(
  connection: Connection,
  query: ProjectArtifactQuery,
): Promise<ArtifactPage> {
  const after = query.cursor ? decodeCursor(query.cursor, 'catalog') : null;
  const listed = await rows<ListedArtifact>(
    connection,
    `SELECT a.*,${CURSOR_TIMESTAMP_SQL} AS listing_created_at FROM artifacts a
     WHERE a.project_id=$1
       AND ($2::text IS NULL OR a.path ILIKE '%' || $2 || '%')
       AND ($3::text IS NULL OR lower(trim(split_part(a.mime_type,';',1))) LIKE $3)
       AND ($4::uuid IS NULL OR a.run_id=$4)
       AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM model_versions version
            WHERE version.id=$5 AND version.project_id=a.project_id AND version.artifact_id=a.id)
         OR EXISTS(SELECT 1 FROM runs run
            WHERE run.id=a.run_id AND run.project_id=a.project_id AND run.model_version_id=$5))
       AND ($6::timestamptz IS NULL OR (a.created_at,a.id)<($6,$7::uuid))
       AND ($8='all' OR ${currentRunArtifactCondition('a')})
       -- Server-side previews are Runless Artifacts the viewer reads through /previews, not catalog items.
       AND (a.run_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM artifact_previews preview
            WHERE preview.preview_artifact_id=a.id))
     ORDER BY a.created_at DESC,a.id DESC LIMIT $9`,
    [
      query.projectId,
      query.query ?? null,
      query.mimeType ? mimeTypePattern(query.mimeType) : null,
      query.runId ?? null,
      query.modelVersionId ?? null,
      after?.createdAt ?? null,
      after?.id ?? null,
      query.versions,
      query.limit + 1,
    ],
  );
  return toPage(listed, query.limit, (last) => ({
    kind: 'catalog',
    createdAt: last.listingCreatedAt,
    id: last.id,
  }));
}
