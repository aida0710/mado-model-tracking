import {
  MAX_DATASET_VERSION_FILES,
  type Artifact,
  type ArtifactTree,
  type DatasetVersionFile,
  type DatasetVersionFilePage,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, type Connection, type Database } from '../db/database.js';
import type {
  DatasetFileListQuery,
  DatasetVersionContentInput,
} from '../domain/datasetContentValidation.js';
import { DomainError, notFound } from '../domain/errors.js';
import { findRun } from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';
import {
  artifactTreeFromGroups,
  directoryPrefix,
  listRunArtifacts,
  MAX_TREE_DIRECTORIES,
  type ArtifactTreeGroup,
} from './artifactListing.js';
import type { DatasetManifestFile } from './datasetVersionRegistration.js';

export interface ResolvedDatasetContent {
  files: DatasetManifestFile[];
  /** The Run whose Artifacts became the version; it is recorded as the version's sourceRunId. */
  sourceRunId: string | null;
}

/**
 * Looks up the Artifacts a creation request names. Artifacts are matched in the request's Project
 * only, so another Project's Artifact ID is reported exactly like an unknown one.
 */
export async function resolveDatasetContent(
  connection: Connection,
  request: { projectId: string; content: DatasetVersionContentInput },
): Promise<ResolvedDatasetContent> {
  const { content, projectId } = request;
  if ('fromRunArtifacts' in content)
    return resolveRunArtifacts(connection, { projectId, ...content.fromRunArtifacts });
  const artifactIds = [...new Set(content.files.map((file) => file.artifactId))];
  const artifacts = await rows<Pick<Artifact, 'id' | 'size' | 'sha256'>>(
    connection,
    `SELECT id,size,sha256 FROM artifacts
    WHERE project_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`,
    [projectId, artifactIds],
  );
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const missing = artifactIds.filter((id) => !artifactsById.has(id));
  if (missing.length)
    throw new DomainError(
      422,
      `このProjectに保存済みのArtifactではありません: ${missing.slice(0, 5).join(', ')}`,
      'dataset_artifact_not_found',
    );
  return {
    files: content.files.map((file) => {
      const artifact = artifactsById.get(file.artifactId)!;
      return { ...file, size: artifact.size, sha256: artifact.sha256 };
    }),
    sourceRunId: null,
  };
}

async function resolveRunArtifacts(
  connection: Connection,
  source: { projectId: string; runId: string; prefix: string },
): Promise<ResolvedDatasetContent> {
  await findRun(connection, { projectId: source.projectId, id: source.runId });
  const prefix = directoryPrefix(source.prefix);
  // Older uploads at a path are superseded; the version takes what the Run shows now.
  const page = await listRunArtifacts(connection, {
    projectId: source.projectId,
    runId: source.runId,
    prefix,
    directFilesOnly: false,
    versions: 'latest',
    limit: MAX_DATASET_VERSION_FILES,
  });
  if (page.nextCursor) tooManyFiles();
  if (!page.items.length)
    throw new DomainError(422, 'prefixの下にRunのArtifactがありません', 'dataset_content_empty');
  return {
    files: page.items.map((artifact) => ({
      path: artifact.path.slice(prefix.length),
      artifactId: artifact.id,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
    sourceRunId: source.runId,
  };
}

function tooManyFiles(): never {
  throw new DomainError(
    422,
    `DatasetVersionのファイル数は${MAX_DATASET_VERSION_FILES}件までです`,
    'dataset_too_many_files',
  );
}

interface DatasetVersionLocation {
  projectId: string;
  datasetId: string;
  versionId: string;
}

/** File lists are in path order; the cursor is the last path of the previous page. */
function encodeFileCursor(path: string): string {
  return Buffer.from(JSON.stringify({ path })).toString('base64url');
}

function decodeFileCursor(token: string): string {
  try {
    const cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (typeof cursor === 'object' && cursor !== null && 'path' in cursor) {
      const { path } = cursor;
      if (typeof path === 'string') return path;
    }
  } catch {
    // Reported below like any other malformed cursor.
  }
  throw new DomainError(400, 'cursorが不正です', 'invalid_cursor');
}

/** Reads the files of DatasetVersions and finds stored Artifacts by content. */
export class DatasetContentService {
  constructor(private readonly database: Database) {}

  async listFiles(
    principal: Principal,
    request: DatasetVersionLocation & { query: DatasetFileListQuery },
  ): Promise<DatasetVersionFilePage> {
    await this.requireReadAccess(principal, request.projectId);
    await this.requireVersion(request);
    const { query } = request;
    const prefix = directoryPrefix(query.prefix);
    const after = query.cursor ? decodeFileCursor(query.cursor) : null;
    const files = await rows<DatasetVersionFile>(
      this.database,
      `SELECT f.path,f.artifact_id,f.size,f.sha256,a.mime_type FROM dataset_version_files f
       JOIN artifacts a ON a.id=f.artifact_id
       WHERE f.dataset_version_id=$1 AND starts_with(f.path,$2)
         AND (NOT $3::boolean OR strpos(substr(f.path,length($2)+1),'/')=0)
         AND ($4::text IS NULL OR f.path>$4)
       ORDER BY f.path LIMIT $5`,
      [request.versionId, prefix, query.delimiter === '/', after, query.limit + 1],
    );
    const items = files.slice(0, query.limit);
    return files.length > query.limit
      ? { items, nextCursor: encodeFileCursor(items.at(-1)!.path) }
      : { items };
  }

  /** One directory level of the version's files, in the same shape as a Run's Artifact tree. */
  async fileTree(
    principal: Principal,
    request: DatasetVersionLocation & { prefix: string },
  ): Promise<ArtifactTree> {
    await this.requireReadAccess(principal, request.projectId);
    await this.requireVersion(request);
    const prefix = directoryPrefix(request.prefix);
    const groups = await rows<ArtifactTreeGroup>(
      this.database,
      `SELECT child,count(*) AS file_count,sum(size) AS total_size FROM (
         SELECT size,CASE WHEN strpos(substr(path,length($2)+1),'/')=0 THEN ''
                     ELSE split_part(substr(path,length($2)+1),'/',1) END AS child
         FROM dataset_version_files WHERE dataset_version_id=$1 AND starts_with(path,$2)
       ) listed GROUP BY child ORDER BY child LIMIT $3`,
      [request.versionId, prefix, MAX_TREE_DIRECTORIES + 2],
    );
    return artifactTreeFromGroups(prefix, groups);
  }

  /**
   * The newest stored Artifact of the Project with this content, so a client can list it in a
   * DatasetVersion instead of uploading the same bytes again. Bytes are not shared between
   * Artifacts; a match is reused only by reference.
   */
  async findArtifactByDigest(
    principal: Principal,
    request: { projectId: string; sha256: string; size: number },
  ): Promise<Artifact> {
    await this.requireReadAccess(principal, request.projectId);
    const artifact = await first<Artifact>(
      this.database,
      `SELECT * FROM artifacts WHERE project_id=$1 AND sha256=$2 AND size=$3 AND deleted_at IS NULL
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [request.projectId, request.sha256, request.size],
    );
    if (!artifact) notFound('Artifact');
    return artifact;
  }

  private async requireVersion(location: DatasetVersionLocation): Promise<void> {
    const version = await first(
      this.database,
      'SELECT 1 FROM dataset_versions WHERE id=$1 AND dataset_id=$2 AND project_id=$3',
      [location.versionId, location.datasetId, location.projectId],
    );
    if (!version) notFound('DatasetVersion');
  }

  private async requireReadAccess(principal: Principal, projectId: string): Promise<void> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
  }
}
