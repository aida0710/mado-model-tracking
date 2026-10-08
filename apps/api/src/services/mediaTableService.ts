import type { Readable } from 'node:stream';
import {
  MEDIA_TABLE_MAX_BYTES,
  type Artifact,
  type MediaTableCell,
  type MediaTableMediaCell,
  type MediaTablePage,
} from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import {
  isParquetTable,
  mediaCellReference,
  parseMediaTable,
  type ArtifactReferenceResult,
  type ParsedMediaTable,
} from '../domain/mediaTable.js';
import { findCurrentRunArtifacts } from '../repositories/runMediaRepository.js';
import type { ArtifactService } from './artifactService.js';

export interface MediaTableLocation {
  projectId: string;
  /** The Run holding the table; relative cell paths name its Artifacts. */
  runId: string;
  artifactId: string;
}

async function readText(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

function fileKey(runId: string, path: string): string {
  return `${runId}\n${path}`;
}

/** Reads media tables (MLflow's split JSON) and resolves their media cells to Artifacts. */
export class MediaTableService {
  constructor(private readonly artifacts: ArtifactService) {}

  /** The parsed table; 413 when it is too large to page here, 422 when it is not a split JSON. */
  async load(connection: Connection, location: Omit<MediaTableLocation, 'runId'>): Promise<ParsedMediaTable> {
    const artifact = await first<Artifact>(
      connection,
      'SELECT * FROM artifacts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL',
      [location.artifactId, location.projectId],
    );
    if (!artifact) notFound('Artifact');
    if (isParquetTable(artifact))
      throw new DomainError(422, 'parquetの表は表示できません。JSONで記録してください', 'unsupported_table_format');
    if (artifact.size > MEDIA_TABLE_MAX_BYTES)
      throw new DomainError(
        413,
        `表が${MEDIA_TABLE_MAX_BYTES / 1024 / 1024}MiBを超えています。Artifactをdownloadして開いてください`,
        'media_table_too_large',
      );
    const content = await this.artifacts.readContent(artifact);
    return parseMediaTable(await readText(content.body));
  }

  async page(
    connection: Connection,
    location: MediaTableLocation,
    window: { offset: number; limit: number },
  ): Promise<MediaTablePage> {
    const table = await this.load(connection, location);
    const pageRows = table.rows.slice(window.offset, window.offset + window.limit);
    const mediaColumns = table.columns.flatMap((column, index) =>
      column.type === 'audio' || column.type === 'image' || column.type === 'video' ? [index] : [],
    );
    const context = { projectId: location.projectId, tableRunId: location.runId };
    const references = pageRows.map((row) =>
      mediaColumns.map((index) => mediaCellReference(row[index], context)),
    );
    const files = references.flat().flatMap((reference) =>
      [reference?.file, reference?.thumbnail].flatMap((result) => (result?.ok ? [result.reference] : [])),
    );
    const found = await findCurrentRunArtifacts(connection, { projectId: location.projectId, files });
    const artifactIds = new Map(found.map((artifact) => [fileKey(artifact.runId, artifact.path), artifact.id]));
    const artifactIdOf = (result: ArtifactReferenceResult | null | undefined) =>
      result?.ok ? (artifactIds.get(fileKey(result.reference.runId, result.reference.path)) ?? null) : null;
    return {
      columns: table.columns,
      rows: pageRows.map((row, rowIndex) =>
        row.map((cell, columnIndex): MediaTableCell => {
          const mediaIndex = mediaColumns.indexOf(columnIndex);
          if (mediaIndex < 0) return (cell ?? null) as MediaTableCell;
          const reference = references[rowIndex]![mediaIndex];
          if (!reference) return null;
          const artifactId = artifactIdOf(reference.file);
          const mediaCell: MediaTableMediaCell = {
            type: reference.type,
            runId: reference.file.ok ? reference.file.reference.runId : null,
            path: reference.file.ok ? reference.file.reference.path : null,
            artifactId,
            thumbnailArtifactId: artifactIdOf(reference.thumbnail),
            error: reference.file.ok ? (artifactId ? null : 'not_found') : reference.file.error,
          };
          return mediaCell;
        }),
      ),
      totalRows: table.rows.length,
      offset: window.offset,
    };
  }
}
