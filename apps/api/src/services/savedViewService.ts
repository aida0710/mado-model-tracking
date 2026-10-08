import type { ProjectRole, SavedView } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { satisfiesProjectRole } from '../domain/projectRoles.js';
import {
  validateSavedViewState,
  type SavedViewCreateInput,
  type SavedViewListQuery,
  type SavedViewPatchInput,
} from '../domain/savedViewValidation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  deleteSavedView,
  findSavedView,
  insertSavedView,
  isSavedViewNameConflict,
  listVisibleSavedViews,
  updateSavedView,
} from '../repositories/savedViewRepository.js';
import { rejectJobToken, requireProject } from './accessService.js';
import {
  auditActor,
  DENIED_STATUSES,
  NO_REQUEST_METADATA,
  type AuditEventDraft,
} from './auditService.js';

interface SavedViewReference {
  projectId: string;
  savedViewId: string;
}

// Saved views are display settings, so token writes use the same scope as Run list changes.
const SAVED_VIEW_WRITE_SCOPE = 'runs:write';
// Sharing a view with the Project changes what every member sees, like other editor actions.
const SHARED_VIEW_ROLE: ProjectRole = 'editor';

// The unique indexes decide name conflicts, so concurrent saves of the same name cannot both win.
async function rejectNameConflict<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (isSavedViewNameConflict(error))
      throw new DomainError(409, '同じ名前の保存ビューが既にあります', 'saved_view_name_conflict');
    throw error;
  }
}

function requireSharingRole(role: ProjectRole): void {
  if (!satisfiesProjectRole(role, SHARED_VIEW_ROLE))
    throw new DomainError(
      403,
      'Project公開の保存ビューを作成・変更できるのはeditor以上です',
      'saved_view_share_forbidden',
    );
}

/**
 * Saved Run list views. A private view is a personal display setting: only its owner sees it and
 * it is not audited. A view shared with the Project is audited on create, update and delete,
 * including refusals, because it changes what other members open.
 */
export class SavedViewService {
  constructor(private readonly database: Database) {}

  async list(
    principal: Principal,
    projectId: string,
    query: SavedViewListQuery,
  ): Promise<{ items: SavedView[] }> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'viewer',
      scope: 'read',
    });
    return {
      items: await listVisibleSavedViews(this.database, {
        projectId,
        page: query.page,
        viewerUserId: principal.user.id,
      }),
    };
  }

  async get(principal: Principal, reference: SavedViewReference): Promise<SavedView> {
    await requireProject(this.database, principal, {
      projectId: reference.projectId,
      role: 'viewer',
      scope: 'read',
    });
    return this.requireVisible(this.database, principal, reference);
  }

  async create(
    principal: Principal,
    projectId: string,
    input: SavedViewCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<SavedView> {
    const draft = this.auditDraft(principal, {
      action: 'saved_view.create',
      projectId,
      savedViewId: null,
      request,
    });
    const shared = input.visibility === 'project';
    return this.auditSharedDenial(
      draft,
      () => shared,
      () =>
        transaction(this.database, async (connection) => {
          rejectJobToken(principal);
          const role = await requireProject(connection, principal, {
            projectId,
            role: 'viewer',
            scope: SAVED_VIEW_WRITE_SCOPE,
          });
          if (shared) requireSharingRole(role);
          const state = validateSavedViewState(input.state);
          await this.requireProjectExperiments(connection, {
            projectId,
            experimentIds: state.experimentIds,
          });
          const view = await rejectNameConflict(
            insertSavedView(connection, {
              projectId,
              ownerUserId: principal.user.id,
              visibility: input.visibility,
              page: input.page,
              name: input.name,
              state,
            }),
          );
          if (shared)
            await writeAuditEvent(connection, {
              ...draft,
              outcome: 'success',
              resourceId: view.id,
              details: { name: view.name, page: view.page },
            });
          return view;
        }),
    );
  }

  async update(
    principal: Principal,
    reference: SavedViewReference & { patch: SavedViewPatchInput },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<SavedView> {
    const { patch } = reference;
    const draft = this.auditDraft(principal, {
      action: 'saved_view.update',
      ...reference,
      request,
    });
    // Known only after the view is loaded; a refusal of a shared view is audited.
    let shared = patch.visibility === 'project';
    return this.auditSharedDenial(
      draft,
      () => shared,
      () =>
        transaction(this.database, async (connection) => {
          const { view, role } = await this.lockForChange(connection, principal, reference);
          shared ||= view.visibility === 'project';
          const visibility = patch.visibility ?? view.visibility;
          const isOwner = view.ownerUserId === principal.user.id;
          if (!isOwner) {
            this.requireProjectAdmin(role);
            // Who can see a view is the owner's decision; an admin may tidy a shared view or delete it.
            if (visibility !== view.visibility)
              throw new DomainError(
                403,
                '保存ビューの公開範囲を変更できるのは作成者だけです',
                'saved_view_owner_required',
              );
          } else if (visibility === 'project') requireSharingRole(role);
          const state =
            patch.state === undefined ? view.state : validateSavedViewState(patch.state);
          if (patch.state !== undefined)
            await this.requireProjectExperiments(connection, {
              projectId: reference.projectId,
              experimentIds: state.experimentIds,
            });
          const updated = await rejectNameConflict(
            updateSavedView(connection, {
              savedViewId: view.id,
              name: patch.name ?? view.name,
              state,
              visibility,
            }),
          );
          if (shared)
            await writeAuditEvent(connection, {
              ...draft,
              outcome: 'success',
              details: {
                name: updated.name,
                changedFields: Object.keys(patch).filter(
                  (field) => patch[field as keyof SavedViewPatchInput] !== undefined,
                ),
                previousVisibility: view.visibility,
                visibility,
                byOwner: isOwner,
              },
            });
          return updated;
        }),
    );
  }

  async delete(
    principal: Principal,
    reference: SavedViewReference,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<void> {
    const draft = this.auditDraft(principal, {
      action: 'saved_view.delete',
      ...reference,
      request,
    });
    let shared = false;
    await this.auditSharedDenial(
      draft,
      () => shared,
      () =>
        transaction(this.database, async (connection) => {
          const { view, role } = await this.lockForChange(connection, principal, reference);
          shared = view.visibility === 'project';
          // An owner may always remove their own view, even after losing the editor role.
          const isOwner = view.ownerUserId === principal.user.id;
          if (!isOwner) this.requireProjectAdmin(role);
          await deleteSavedView(connection, view.id);
          if (shared)
            await writeAuditEvent(connection, {
              ...draft,
              outcome: 'success',
              details: { name: view.name, byOwner: isOwner },
            });
        }),
    );
  }

  private auditDraft(
    principal: Principal,
    event: {
      action: string;
      projectId: string;
      savedViewId: string | null;
      request: RequestMetadata;
    },
  ): AuditEventDraft {
    return {
      ...auditActor(principal),
      ...event.request,
      action: event.action,
      resourceType: 'saved_view',
      resourceId: event.savedViewId,
      projectId: event.projectId,
    };
  }

  /**
   * Like auditService.recordDenial, but only for shared views: whether the view is shared may be
   * known only after it is loaded inside the operation, so the condition is read afterwards.
   */
  private async auditSharedDenial<T>(
    draft: AuditEventDraft,
    isShared: () => boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DomainError && DENIED_STATUSES.has(error.status) && isShared())
        await writeAuditEvent(this.database, {
          ...draft,
          outcome: 'denied',
          details: { ...draft.details, code: error.code },
        });
      throw error;
    }
  }

  private async lockForChange(
    connection: Connection,
    principal: Principal,
    reference: SavedViewReference,
  ): Promise<{ view: SavedView; role: ProjectRole }> {
    rejectJobToken(principal);
    const role = await requireProject(connection, principal, {
      projectId: reference.projectId,
      role: 'viewer',
      scope: SAVED_VIEW_WRITE_SCOPE,
    });
    const view = await this.requireVisible(connection, principal, {
      ...reference,
      lock: true,
    });
    return { view, role };
  }

  // Another member's private view is reported as missing so its existence is not revealed.
  private async requireVisible(
    connection: Connection,
    principal: Principal,
    reference: SavedViewReference & { lock?: boolean },
  ): Promise<SavedView> {
    const view = await findSavedView(connection, reference);
    if (!view || (view.visibility === 'private' && view.ownerUserId !== principal.user.id))
      notFound('保存ビュー');
    return view;
  }

  private requireProjectAdmin(role: ProjectRole): void {
    if (role !== 'admin')
      throw new DomainError(
        403,
        '他人の保存ビューを変更・削除できるのはProject管理者だけです',
        'saved_view_owner_required',
      );
  }

  // A view refers to experiments by ID; one from another Project would never match a Run.
  private async requireProjectExperiments(
    connection: Connection,
    view: { projectId: string; experimentIds: string[] },
  ): Promise<void> {
    if (!view.experimentIds.length) return;
    const found = await first<{ count: number }>(
      connection,
      'SELECT count(*)::int AS count FROM experiments WHERE project_id=$1 AND id=ANY($2::uuid[])',
      [view.projectId, view.experimentIds],
    );
    if (found!.count !== new Set(view.experimentIds).size)
      throw new DomainError(
        422,
        '保存ビューのexperimentがこのProjectにありません',
        'saved_view_experiment_not_found',
      );
  }
}
