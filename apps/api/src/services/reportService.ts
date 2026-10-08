import type {
  Report,
  ReportBlock,
  ReportBlockSnapshot,
  ReportDetail,
  ReportPage,
  ReportRevision,
  ReportRevisionSummary,
  ReportSnapshotList,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import {
  collectReportReferences,
  isSnapshotBlock,
  reportBlockDigest,
  validateReportBlocks,
  type ReportCreateInput,
  type ReportListQuery,
  type ReportUpdateInput,
} from '../domain/reportBlocks.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  countProjectRows,
  findReport,
  findRevision,
  findRunMediaKind,
  findSavedViewVisibilities,
  insertReport,
  insertRevision,
  insertSnapshots,
  listReports,
  listRevisions,
  listSnapshots,
  updateReportArchive,
  updateReportHead,
  type ReportReferenceTable,
  type SnapshotRow,
} from '../repositories/reportRepository.js';
import { requireProject } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';
import type { ReportSnapshotService } from './reportSnapshotService.js';
import type { RunMediaService } from './runMediaService.js';

interface ReportReference {
  projectId: string;
  reportId: string;
}

// Reports are shared pages about Runs, so token writes use the same scope as Run changes.
const REPORT_WRITE_SCOPE = 'runs:write';

/** A saved revision with its snapshots, whose unchanged snapshot blocks the next save carries over. */
interface CarriedRevision {
  revision: ReportRevision;
  snapshots: ReportBlockSnapshot[];
}

interface RevisionDraft {
  title: string;
  blocks: ReportBlock[];
  message: string | null;
  restoredFromRevision: number | null;
}

function invalidReference(message: string): never {
  throw new DomainError(422, message, 'report_reference_invalid');
}

function requireUnarchived(report: Report): void {
  if (report.archivedAt !== null)
    throw new DomainError(
      409,
      'アーカイブ済みのレポートは編集できません。先にアーカイブを解除してください',
      'report_archived',
    );
}

function requireBaseRevision(report: Report, baseRevision: number): void {
  if (report.currentRevision !== baseRevision)
    throw new DomainError(
      409,
      `ほかの編集が版${report.currentRevision}として保存されています。最新の版を開き直してから編集してください`,
      'report_revision_conflict',
    );
}

/**
 * Shared reports and their immutable revisions. Any Project editor may save a new revision; the
 * revision records who saved it. A save fails with 409 instead of overwriting another editor's
 * revision. Reports are archived instead of deleted, by their creator or a Project admin.
 */
export class ReportService {
  constructor(
    private readonly database: Database,
    private readonly dependencies: {
      snapshots: ReportSnapshotService;
      runMedia: RunMediaService;
      /** MMT_REPORT_SNAPSHOT_MAX_BYTES: the snapshot data of one revision. */
      snapshotMaxBytes: number;
    },
  ) {}

  async list(principal: Principal, projectId: string, query: ReportListQuery): Promise<ReportPage> {
    await this.requireViewer(principal, projectId);
    const page = await listReports(this.database, { projectId, ...query });
    if (!page.cursorFound)
      throw new DomainError(400, 'cursorが不正です', 'invalid_cursor');
    const hasMore = page.items.length > query.limit;
    const items = page.items.slice(0, query.limit);
    return { items, nextCursor: hasMore ? items.at(-1)!.id : null };
  }

  async get(
    principal: Principal,
    reference: ReportReference & { revision?: number },
  ): Promise<ReportDetail> {
    await this.requireViewer(principal, reference.projectId);
    const report = await this.requireReport(this.database, reference);
    return {
      report,
      revision: await this.requireRevision(this.database, {
        reportId: report.id,
        revision: reference.revision ?? report.currentRevision,
      }),
    };
  }

  async listRevisions(
    principal: Principal,
    reference: ReportReference,
  ): Promise<{ items: ReportRevisionSummary[] }> {
    await this.requireViewer(principal, reference.projectId);
    const report = await this.requireReport(this.database, reference);
    return { items: await listRevisions(this.database, report.id) };
  }

  async listSnapshots(
    principal: Principal,
    reference: ReportReference & { revision?: number },
  ): Promise<ReportSnapshotList> {
    await this.requireViewer(principal, reference.projectId);
    const report = await this.requireReport(this.database, reference);
    const revision = await this.requireRevision(this.database, {
      reportId: report.id,
      revision: reference.revision ?? report.currentRevision,
    });
    return {
      revision: revision.revision,
      items: await listSnapshots(this.database, { reportId: report.id, revision: revision.revision }),
    };
  }

  async create(
    principal: Principal,
    projectId: string,
    input: ReportCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<ReportDetail> {
    const draft = this.auditDraft(principal, {
      action: 'report.create',
      projectId,
      reportId: null,
      request,
    });
    return recordDenial(this.database, draft, async () => {
      validateReportBlocks(input.blocks);
      await this.requireEditor(this.database, principal, projectId);
      await this.requireReferences(principal, projectId, input.blocks);
      const snapshots = await this.prepareSnapshots(principal, {
        projectId,
        blocks: input.blocks,
        revision: 1,
        carried: null,
        refreshBlockIds: new Set(),
      });
      return transaction(this.database, async (connection) => {
        const reportId = await insertReport(connection, {
          projectId,
          title: input.title,
          createdBy: principal.user.id,
        });
        return this.writeRevision(connection, {
          reference: { projectId, reportId },
          revision: 1,
          draft: {
            title: input.title,
            blocks: input.blocks,
            message: input.message || null,
            restoredFromRevision: null,
          },
          snapshots,
          principal,
          audit: { ...draft, resourceId: reportId },
        });
      });
    });
  }

  async update(
    principal: Principal,
    reference: ReportReference & { update: ReportUpdateInput },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<ReportDetail> {
    const { update } = reference;
    const draft = this.auditDraft(principal, { action: 'report.update', ...reference, request });
    return recordDenial(this.database, draft, async () => {
      validateReportBlocks(update.blocks);
      await this.requireEditor(this.database, principal, reference.projectId);
      const report = await this.requireReport(this.database, reference);
      requireUnarchived(report);
      requireBaseRevision(report, update.baseRevision);
      await this.requireReferences(principal, reference.projectId, update.blocks);
      const snapshots = await this.prepareSnapshots(principal, {
        projectId: reference.projectId,
        blocks: update.blocks,
        revision: update.baseRevision + 1,
        carried: await this.readCarriedRevision(report.id, report.currentRevision),
        refreshBlockIds: new Set(update.refreshSnapshotBlockIds),
      });
      return this.saveNextRevision(principal, {
        reference,
        baseRevision: update.baseRevision,
        draft: {
          title: update.title,
          blocks: update.blocks,
          message: update.message || null,
          restoredFromRevision: null,
        },
        snapshots,
        audit: draft,
      });
    });
  }

  /** Saves the content of an earlier revision as a new revision; the history stays as it is. */
  async restore(
    principal: Principal,
    reference: ReportReference & { revision: number },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<ReportDetail> {
    const draft = this.auditDraft(principal, { action: 'report.restore', ...reference, request });
    return recordDenial(this.database, draft, async () => {
      await this.requireEditor(this.database, principal, reference.projectId);
      const report = await this.requireReport(this.database, reference);
      requireUnarchived(report);
      const source = await this.readCarriedRevision(report.id, reference.revision);
      // Saved views or Runs may have changed since; the restored content must still be shareable.
      await this.requireReferences(principal, reference.projectId, source.revision.blocks);
      // The restored blocks are the source's own, so their snapshots keep the source's data.
      const snapshots = await this.prepareSnapshots(principal, {
        projectId: reference.projectId,
        blocks: source.revision.blocks,
        revision: report.currentRevision + 1,
        carried: source,
        refreshBlockIds: new Set(),
      });
      return this.saveNextRevision(principal, {
        reference,
        baseRevision: report.currentRevision,
        draft: {
          title: source.revision.title,
          blocks: source.revision.blocks,
          message: null,
          restoredFromRevision: source.revision.revision,
        },
        snapshots,
        audit: draft,
      });
    });
  }

  async archive(
    principal: Principal,
    reference: ReportReference,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Report> {
    return this.changeArchive(principal, { ...reference, archived: true }, request);
  }

  async unarchive(
    principal: Principal,
    reference: ReportReference,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Report> {
    return this.changeArchive(principal, { ...reference, archived: false }, request);
  }

  private async changeArchive(
    principal: Principal,
    reference: ReportReference & { archived: boolean },
    request: RequestMetadata,
  ): Promise<Report> {
    const draft = this.auditDraft(principal, {
      action: reference.archived ? 'report.archive' : 'report.unarchive',
      ...reference,
      request,
    });
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        const role = await this.requireEditor(connection, principal, reference.projectId);
        const report = await this.requireReport(connection, { ...reference, lock: true });
        if (report.createdBy.id !== principal.user.id && role !== 'admin')
          throw new DomainError(
            403,
            'レポートのアーカイブと解除ができるのは作成者かProject管理者だけです',
            'report_owner_required',
          );
        // Repeating the current state changes nothing and is not audited again.
        if ((report.archivedAt !== null) === reference.archived) return report;
        await updateReportArchive(connection, {
          reportId: report.id,
          archivedBy: reference.archived ? principal.user.id : null,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { title: report.title, byCreator: report.createdBy.id === principal.user.id },
        });
        return (await findReport(connection, reference))!;
      }),
    );
  }

  /** Writes revision baseRevision+1 unless another save or an archive got there first. */
  private async saveNextRevision(
    principal: Principal,
    save: {
      reference: ReportReference;
      baseRevision: number;
      draft: RevisionDraft;
      snapshots: SnapshotRow[];
      audit: AuditEventDraft;
    },
  ): Promise<ReportDetail> {
    return transaction(this.database, async (connection) => {
      const report = await this.requireReport(connection, { ...save.reference, lock: true });
      requireUnarchived(report);
      requireBaseRevision(report, save.baseRevision);
      return this.writeRevision(connection, {
        reference: save.reference,
        revision: save.baseRevision + 1,
        draft: save.draft,
        snapshots: save.snapshots,
        principal,
        audit: save.audit,
      });
    });
  }

  private async writeRevision(
    connection: Connection,
    write: {
      reference: ReportReference;
      revision: number;
      draft: RevisionDraft;
      snapshots: SnapshotRow[];
      principal: Principal;
      audit: AuditEventDraft;
    },
  ): Promise<ReportDetail> {
    const { reference, revision, draft } = write;
    await insertRevision(connection, {
      reportId: reference.reportId,
      revision,
      ...draft,
      createdBy: write.principal.user.id,
    });
    await insertSnapshots(connection, {
      reportId: reference.reportId,
      revision,
      snapshots: write.snapshots,
    });
    await updateReportHead(connection, { reportId: reference.reportId, revision, title: draft.title });
    await writeAuditEvent(connection, {
      ...write.audit,
      outcome: 'success',
      details: {
        title: draft.title,
        revision,
        blockCount: draft.blocks.length,
        capturedBlockIds: write.snapshots
          .filter((snapshot) => snapshot.capturedAt === null)
          .map((snapshot) => snapshot.blockId),
        ...(draft.restoredFromRevision === null
          ? {}
          : { restoredFromRevision: draft.restoredFromRevision }),
      },
    });
    return {
      report: (await findReport(connection, reference))!,
      revision: (await findRevision(connection, { reportId: reference.reportId, revision }))!,
    };
  }

  /**
   * Snapshot data of the snapshot-mode blocks. A block whose content equals the carried revision's
   * block keeps that snapshot (and its capture time) unless it is asked to be refreshed.
   */
  private async prepareSnapshots(
    principal: Principal,
    save: {
      projectId: string;
      blocks: ReportBlock[];
      revision: number;
      carried: CarriedRevision | null;
      refreshBlockIds: ReadonlySet<string>;
    },
  ): Promise<SnapshotRow[]> {
    const carriedDigests = new Map(
      save.carried?.revision.blocks.map((block) => [block.id, reportBlockDigest(block)]),
    );
    const carriedSnapshots = new Map(
      save.carried?.snapshots.map((snapshot) => [snapshot.blockId, snapshot]),
    );
    const snapshots: SnapshotRow[] = [];
    let totalBytes = 0;
    for (const block of save.blocks.filter(isSnapshotBlock)) {
      const carried = carriedSnapshots.get(block.id);
      const isUnchanged =
        carried !== undefined &&
        carriedDigests.get(block.id) === reportBlockDigest(block) &&
        !save.refreshBlockIds.has(block.id);
      const snapshot: SnapshotRow = isUnchanged
        ? {
            blockId: block.id,
            data: carried.data,
            capturedAt: carried.capturedAt,
            capturedRevision: carried.capturedRevision,
            sizeBytes: carried.sizeBytes,
          }
        : {
            blockId: block.id,
            ...(await this.dependencies.snapshots.capture(
              { principal, projectId: save.projectId },
              block,
            )),
            capturedAt: null,
            capturedRevision: save.revision,
          };
      totalBytes += snapshot.sizeBytes;
      if (totalBytes > this.dependencies.snapshotMaxBytes)
        throw new DomainError(
          413,
          '1つの版の固定データの合計が上限を超えます。固定するブロックを減らしてください',
          'report_snapshot_too_large',
        );
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  private async readCarriedRevision(reportId: string, revision: number): Promise<CarriedRevision> {
    return {
      revision: await this.requireRevision(this.database, { reportId, revision }),
      snapshots: await listSnapshots(this.database, { reportId, revision }),
    };
  }

  /**
   * Everything a revision names must be in the report's Project, so a shared page never shows
   * another Project's data. Saved views must be shared with the Project: other members could not
   * open a private one.
   */
  private async requireReferences(
    principal: Principal,
    projectId: string,
    blocks: readonly ReportBlock[],
  ): Promise<void> {
    const references = collectReportReferences(blocks);
    const tables: [ReportReferenceTable, string[]][] = [
      ['runs', references.runIds],
      ['sweeps', references.sweepIds],
      ['experiments', references.experimentIds],
      ['model_versions', references.modelVersionIds],
      ['dataset_versions', references.datasetVersionIds],
    ];
    for (const [table, ids] of tables)
      if ((await countProjectRows(this.database, { table, projectId, ids })) !== ids.length)
        invalidReference('レポートが参照するRun・Sweep・版などがこのProjectにありません');
    const views = await findSavedViewVisibilities(this.database, {
      projectId,
      savedViewIds: references.savedViewIds,
    });
    if (views.length !== references.savedViewIds.length)
      invalidReference('レポートが参照する保存ビューがこのProjectにありません');
    if (views.some((view) => view.visibility !== 'project'))
      throw new DomainError(
        422,
        '非公開の保存ビューはレポートから参照できません。Projectに公開してから参照してください',
        'report_saved_view_private',
      );
    for (const media of references.media)
      await this.requireMediaTable(principal, { projectId, ...media });
  }

  // Tables logged by MLflow have no run_media row; opening their first row checks they exist.
  private async requireMediaTable(
    principal: Principal,
    media: { projectId: string; runId: string; mediaId: string },
  ): Promise<void> {
    const kind = await findRunMediaKind(this.database, media);
    if (kind === 'table') return;
    if (kind !== undefined) invalidReference('レポートが参照するmediaは表ではありません');
    try {
      await this.dependencies.runMedia.table(principal, media, { offset: 0, limit: 1 });
    } catch (error) {
      if (error instanceof DomainError && [404, 422].includes(error.status))
        invalidReference('レポートが参照する表がこのRunにありません');
      throw error;
    }
  }

  private async requireViewer(principal: Principal, projectId: string): Promise<void> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
  }

  private async requireEditor(connection: Connection, principal: Principal, projectId: string) {
    return requireProject(connection, principal, {
      projectId,
      role: 'editor',
      scope: REPORT_WRITE_SCOPE,
    });
  }

  private async requireReport(
    connection: Connection,
    reference: ReportReference & { lock?: boolean },
  ): Promise<Report> {
    const report = await findReport(connection, reference);
    if (!report) notFound('レポート');
    return report;
  }

  private async requireRevision(
    connection: Connection,
    revision: { reportId: string; revision: number },
  ): Promise<ReportRevision> {
    const found = await findRevision(connection, revision);
    if (!found) notFound('レポートの版');
    return found;
  }

  private auditDraft(
    principal: Principal,
    event: {
      action: string;
      projectId: string;
      reportId: string | null;
      request: RequestMetadata;
    },
  ): AuditEventDraft {
    return {
      ...auditActor(principal),
      ...event.request,
      action: event.action,
      resourceType: 'report',
      resourceId: event.reportId,
      projectId: event.projectId,
    };
  }
}
