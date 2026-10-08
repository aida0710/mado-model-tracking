import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  MLFLOW_LOGGED_ARTIFACTS_TAG,
  type ArtifactMediaInfo,
  type MediaCompareGrid,
  type MediaTablePage,
  type RunMedia,
  type RunMediaKeySummary,
  type RunMediaPage,
  type Run,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { parseLoggedTablePaths } from '../domain/mlflowMediaPaths.js';
import {
  isMediaKindCompatible,
  type MediaCompareInput,
  type MediaTableQuery,
  type RunMediaCreateInput,
  type RunMediaCreateItemInput,
  type RunMediaListQuery,
} from '../domain/runMediaValidation.js';
import { findRun } from '../repositories/registryRepository.js';
import {
  findCurrentRunArtifacts,
  findIndexedArtifactIds,
  findProjectArtifacts,
  findRunMedia,
  findRunMediaByIds,
  findRunMediaTriples,
  findRunTags,
  insertRunMedia,
  listComparedMedia,
  listMediaInfo,
  listRunMediaKeys,
  listRunMediaPage,
  type RunMediaRecord,
} from '../repositories/runMediaRepository.js';
import { requireProject } from './accessService.js';
import type { MediaTableService } from './mediaTableService.js';
import { assertRunRecordsWritable } from './runService.js';

type RunReference = { projectId: string; runId: string };
// PostgreSQL unique_violation.
const UNIQUE_VIOLATION = '23505';
type RunTags = { id: string; tags: Record<string, string> };

function contentUrl(projectId: string, artifactId: string): string {
  return `/api/projects/${projectId}/artifacts/${artifactId}/content`;
}

/**
 * A stable id for a table listed in the mlflow.loggedArtifacts tag, which has no run_media row:
 * the same Run and path always give the same id, so the table URL keeps working.
 */
function loggedTableMediaId(runId: string, path: string): string {
  const digest = createHash('sha256').update(`mlflow-table\n${runId}\n${path}`).digest('hex');
  // RFC 9562 version 8 (custom) with the variant bits set, so it passes UUID validation.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `8${digest.slice(13, 16)}`,
    `${((parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

function sameItem(record: RunMediaRecord, item: RunMediaCreateItemInput, run: RunReference): boolean {
  return (
    record.projectId === run.projectId &&
    record.runId === run.runId &&
    record.source === 'native' &&
    record.key === item.key &&
    record.step === item.step &&
    record.kind === item.kind &&
    record.artifactId === item.artifactId &&
    record.caption === item.caption &&
    isDeepStrictEqual(record.metadata, item.metadata)
  );
}

function assertNoDuplicateItems(items: readonly RunMediaCreateItemInput[]): void {
  const ids = items.flatMap((item) => (item.id ? [item.id] : []));
  const triples = items.map((item) => JSON.stringify([item.key, item.step, item.artifactId]));
  if (new Set(ids).size !== ids.length || new Set(triples).size !== triples.length)
    throw new DomainError(
      422,
      '同じidまたは同じkey・step・Artifactの項目が重複しています',
      'media_duplicate_item',
    );
}

export class RunMediaService {
  constructor(
    private readonly database: Database,
    private readonly tables: MediaTableService,
  ) {}

  /**
   * Registers media of a Run. Items whose id is already stored with the same content are returned
   * as they are, so an offline resend succeeds even after the Run has ended.
   */
  async create(principal: Principal, reference: RunReference, input: RunMediaCreateInput): Promise<RunMedia[]> {
    assertNoDuplicateItems(input.items);
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId: reference.projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      // The Run lock serializes registrations of one Run, so the duplicate checks below hold.
      const run = await findRun(connection, { projectId: reference.projectId, id: reference.runId, lock: true });
      const items = input.items.map((item) => ({ ...item, id: item.id ?? randomUUID() }));
      const stored = new Map(
        (await findRunMediaByIds(connection, items.map((item) => item.id))).map((record) => [record.id, record]),
      );
      for (const item of items) {
        const record = stored.get(item.id);
        if (record && !sameItem(record, item, { projectId: reference.projectId, runId: run.id }))
          throw new DomainError(409, 'このidのmediaは別の内容で登録済みです', 'media_conflict');
      }
      const newItems = items.filter((item) => !stored.has(item.id));
      if (newItems.length > 0) {
        await assertRunRecordsWritable(connection, run);
        await this.assertArtifactsUsable(connection, { projectId: reference.projectId, runId: run.id, items: newItems });
        if ((await findRunMediaTriples(connection, { runId: run.id, items: newItems })).length > 0)
          throw new DomainError(409, '同じkey・step・Artifactのmediaは登録済みです', 'media_exists');
        try {
          await insertRunMedia(
            connection,
            newItems.map((item) => ({ ...item, projectId: reference.projectId, runId: run.id })),
          );
        } catch (error) {
          // Another Run took the same client-chosen id meanwhile.
          if ((error as { code?: string }).code === UNIQUE_VIOLATION)
            throw new DomainError(409, 'このidのmediaは別の内容で登録済みです', 'media_conflict');
          throw error;
        }
      }
      const records = new Map(
        (await findRunMediaByIds(connection, items.map((item) => item.id))).map((record) => [record.id, record]),
      );
      return this.toRunMedia(
        connection,
        reference.projectId,
        items.map((item) => records.get(item.id)!),
      );
    });
  }

  private async assertArtifactsUsable(
    connection: Connection,
    request: RunReference & { items: readonly RunMediaCreateItemInput[] },
  ): Promise<void> {
    const artifacts = new Map(
      (
        await findProjectArtifacts(connection, {
          projectId: request.projectId,
          ids: request.items.map((item) => item.artifactId),
        })
      ).map((artifact) => [artifact.id, artifact]),
    );
    for (const item of request.items) {
      const artifact = artifacts.get(item.artifactId);
      // An upload session that has not completed has no Artifact yet.
      if (!artifact)
        throw new DomainError(
          422,
          '保存が完了したArtifactを指定してください',
          'media_artifact_unavailable',
        );
      if (artifact.runId !== request.runId)
        throw new DomainError(422, '同じRunに保存したArtifactを指定してください', 'media_artifact_run');
      if (!isMediaKindCompatible(item.kind, artifact.mimeType))
        throw new DomainError(422, 'mediaの種類とArtifactのMIME typeが一致しません', 'media_kind_mismatch');
      if (item.kind === 'table')
        await this.tables.load(connection, { projectId: request.projectId, artifactId: artifact.id });
    }
  }

  async keys(principal: Principal, reference: RunReference): Promise<RunMediaKeySummary[]> {
    const run = await this.requireRunReader(principal, reference);
    const summaries = await listRunMediaKeys(this.database, reference);
    for (const table of await this.loggedTables(this.database, reference.projectId, [run])) {
      const summary = summaries.find((entry) => entry.key === table.key && entry.kind === 'table');
      if (summary) {
        summary.count += 1;
        summary.minStep = Math.min(summary.minStep, table.step);
      } else summaries.push({ key: table.key, kind: 'table', count: 1, minStep: table.step, maxStep: table.step });
    }
    return summaries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  }

  /**
   * Step order. Tables from the mlflow.loggedArtifacts tag are step 0 and come at the start of the
   * first page, outside the limit, since they have no row to page by.
   */
  async list(principal: Principal, query: RunReference & RunMediaListQuery): Promise<RunMediaPage> {
    const run = await this.requireRunReader(principal, query);
    const page = await listRunMediaPage(this.database, query);
    const includesLoggedTables =
      !query.cursor &&
      (query.kind === undefined || query.kind === 'table') &&
      (query.stepFrom === undefined || query.stepFrom === 0);
    const loggedTables = includesLoggedTables
      ? (await this.loggedTables(this.database, query.projectId, [run])).filter(
          (table) => query.key === undefined || table.key === query.key,
        )
      : [];
    const items = await this.toRunMedia(this.database, query.projectId, [...loggedTables, ...page.items]);
    return page.nextCursor ? { items, nextCursor: page.nextCursor } : { items };
  }

  async compare(principal: Principal, projectId: string, input: MediaCompareInput): Promise<MediaCompareGrid> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const runs = await findRunTags(this.database, { projectId, runIds: input.runIds });
    if (runs.length !== input.runIds.length) notFound('Run');
    const stored = await listComparedMedia(this.database, {
      projectId,
      runIds: input.runIds,
      key: input.key,
      kind: input.kind,
      steps: input.steps ?? null,
    });
    const loggedTables =
      input.kind === undefined || input.kind === 'table'
        ? (await this.loggedTables(this.database, projectId, runs)).filter((table) => table.key === input.key)
        : [];
    const media = await this.toRunMedia(this.database, projectId, [...loggedTables, ...stored]);
    const rows = input.runIds.map((runId) => {
      const ofRun = media.filter((item) => item.runId === runId);
      const atStep = (step: number) => {
        const found = ofRun.filter((item) => item.step === step);
        return found.length > 0 ? found : null;
      };
      if (input.steps) return { runId, cells: input.steps.map(atStep) };
      // Without steps each Run shows its own latest step; a Run without the key has one null cell.
      const latest = ofRun.length > 0 ? Math.max(...ofRun.map((item) => item.step)) : null;
      return { runId, cells: [latest === null ? null : atStep(latest)] };
    });
    return { key: input.key, steps: input.steps ?? null, rows };
  }

  async table(
    principal: Principal,
    reference: RunReference & { mediaId: string },
    query: MediaTableQuery,
  ): Promise<MediaTablePage> {
    const run = await this.requireRunReader(principal, reference);
    const media =
      (await findRunMedia(this.database, { ...reference, id: reference.mediaId })) ??
      (await this.loggedTables(this.database, reference.projectId, [run])).find(
        (table) => table.id === reference.mediaId.toLowerCase(),
      );
    if (!media) notFound('media');
    if (media.kind !== 'table')
      throw new DomainError(422, 'このmediaは表ではありません', 'media_not_table');
    return this.tables.page(
      this.database,
      { projectId: reference.projectId, runId: media.runId, artifactId: media.artifactId },
      query,
    );
  }

  private async requireRunReader(principal: Principal, reference: RunReference): Promise<Run> {
    await requireProject(this.database, principal, {
      projectId: reference.projectId,
      role: 'viewer',
      scope: 'read',
    });
    return findRun(this.database, { projectId: reference.projectId, id: reference.runId });
  }

  /** Tables listed in the Runs' mlflow.loggedArtifacts tags whose file exists and has no row. */
  private async loggedTables(connection: Connection, projectId: string, runs: readonly RunTags[]): Promise<RunMediaRecord[]> {
    const files = runs.flatMap((run) =>
      parseLoggedTablePaths(run.tags[MLFLOW_LOGGED_ARTIFACTS_TAG]).map((path) => ({ runId: run.id, path })),
    );
    const artifacts = await findCurrentRunArtifacts(connection, { projectId, files });
    const indexed = await findIndexedArtifactIds(
      connection,
      artifacts.map((artifact) => artifact.id),
    );
    return artifacts
      .filter((artifact) => !indexed.has(artifact.id))
      .map((artifact) => ({
        id: loggedTableMediaId(artifact.runId, artifact.path),
        projectId,
        runId: artifact.runId,
        key: artifact.path,
        step: 0,
        kind: 'table' as const,
        artifactId: artifact.id,
        thumbnailArtifactId: null,
        caption: null,
        metadata: {},
        source: 'mlflow' as const,
        path: artifact.path,
        mimeType: artifact.mimeType,
        size: artifact.size,
        createdAt: artifact.createdAt,
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  private async toRunMedia(
    connection: Connection,
    projectId: string,
    records: readonly RunMediaRecord[],
  ): Promise<RunMedia[]> {
    const mediaInfo = new Map<string, ArtifactMediaInfo>(
      (await listMediaInfo(connection, { projectId, artifactIds: records.map((record) => record.artifactId) })).map(
        (info) => [info.artifactId, info],
      ),
    );
    return records.map(({ projectId: _projectId, ...record }) => {
      const info = mediaInfo.get(record.artifactId);
      return {
        ...record,
        contentUrl: contentUrl(projectId, record.artifactId),
        thumbnailContentUrl: record.thumbnailArtifactId
          ? contentUrl(projectId, record.thumbnailArtifactId)
          : null,
        ...(info ? { mediaInfo: info } : {}),
      };
    });
  }
}
