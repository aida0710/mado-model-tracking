import type { Comment, CommentPage, ProjectRole } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import type { CommentCreateInput, CommentListQuery } from '../domain/commentValidation.js';
import { DomainError, notFound } from '../domain/errors.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  commentCursorExists,
  findComment,
  insertComment,
  listThreadComments,
  markCommentDeleted,
  toComment,
  updateCommentBody,
  type CommentTarget,
  type StoredComment,
} from '../repositories/commentRepository.js';
import { rejectJobToken, requireProject, requireScope } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';
import type { CommentTargetRegistry } from './commentTargets.js';

interface CommentReference {
  projectId: string;
  commentId: string;
}

/** Threaded comments on Runs, ModelVersions and reports. Audit details never include the body. */
export class CommentService {
  constructor(
    private readonly database: Database,
    private readonly targets: CommentTargetRegistry,
  ) {}

  async list(
    principal: Principal,
    projectId: string,
    query: CommentListQuery,
  ): Promise<CommentPage> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const target: CommentTarget = {
      projectId,
      targetType: query.targetType,
      targetId: query.targetId,
    };
    await this.requireTargetState(this.database, target);
    if (
      query.cursor &&
      !(await commentCursorExists(this.database, { ...target, commentId: query.cursor }))
    )
      notFound('Comment cursor');
    // Fetch one extra row to know whether another page exists without a count query.
    const stored = await listThreadComments(this.database, {
      ...target,
      cursor: query.cursor ?? null,
      limit: query.limit + 1,
    });
    const items = stored.slice(0, query.limit).map(toComment);
    return { items, nextCursor: stored.length > query.limit ? items.at(-1)!.id : null };
  }

  async create(
    principal: Principal,
    projectId: string,
    input: CommentCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Comment> {
    const target: CommentTarget = {
      projectId,
      targetType: input.targetType,
      targetId: input.targetId,
    };
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'comment.create',
      resourceType: 'comment',
      resourceId: null,
      projectId,
      details: { targetType: target.targetType, targetId: target.targetId },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        rejectJobToken(principal);
        const definition = this.targets.definition(target.targetType);
        await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: definition.writeScope,
        });
        if ((await this.requireTargetState(connection, target)) === 'deleted')
          throw new DomainError(
            409,
            '削除済みの対象にはコメントできません',
            'comment_target_deleted',
          );
        const parentCommentId = input.parentCommentId
          ? await this.threadRootId(connection, { ...target, commentId: input.parentCommentId })
          : null;
        const comment = await insertComment(connection, {
          ...target,
          parentCommentId,
          body: input.body,
          authorUserId: principal.user.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          resourceId: comment.id,
          details: { ...draft.details, parentCommentId },
        });
        return toComment(comment);
      }),
    );
  }

  async update(
    principal: Principal,
    reference: CommentReference & { body: string },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Comment> {
    const draft = this.changeDraft(principal, reference, { action: 'comment.update', request });
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        const { comment } = await this.lockForChange(connection, principal, reference);
        if (comment.authorUserId !== principal.user.id)
          throw new DomainError(
            403,
            'コメントを編集できるのは作成者だけです',
            'comment_author_required',
          );
        if (comment.deletedAt)
          throw new DomainError(409, '削除済みのコメントは編集できません', 'comment_deleted');
        await updateCommentBody(connection, { commentId: comment.id, body: reference.body });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { targetType: comment.targetType, targetId: comment.targetId },
        });
        return toComment((await findComment(connection, reference))!);
      }),
    );
  }

  async delete(
    principal: Principal,
    reference: CommentReference,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<void> {
    const draft = this.changeDraft(principal, reference, { action: 'comment.delete', request });
    await recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        const { comment, role } = await this.lockForChange(connection, principal, reference);
        const isAuthor = comment.authorUserId === principal.user.id;
        if (!isAuthor && role !== 'admin')
          throw new DomainError(
            403,
            'コメントを削除できるのは作成者かProject管理者だけです',
            'comment_delete_forbidden',
          );
        // Deleting twice is a no-op so a retried request does not add a second audit row.
        if (comment.deletedAt) return;
        await markCommentDeleted(connection, {
          commentId: comment.id,
          deletedByUserId: principal.user.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            targetType: comment.targetType,
            targetId: comment.targetId,
            byAuthor: isAuthor,
          },
        });
      }),
    );
  }

  private changeDraft(
    principal: Principal,
    reference: CommentReference,
    change: { action: string; request: RequestMetadata },
  ): AuditEventDraft {
    return {
      ...auditActor(principal),
      ...change.request,
      action: change.action,
      resourceType: 'comment',
      resourceId: reference.commentId,
      projectId: reference.projectId,
    };
  }

  // Editing and deleting need write access for the comment's target kind, checked after loading it.
  private async lockForChange(
    connection: Connection,
    principal: Principal,
    reference: CommentReference,
  ): Promise<{ comment: StoredComment; role: ProjectRole }> {
    rejectJobToken(principal);
    const role = await requireProject(connection, principal, {
      projectId: reference.projectId,
      role: 'editor',
      scope: 'read',
    });
    const comment = await findComment(connection, { ...reference, lock: true });
    if (!comment) notFound('Comment');
    requireScope(principal, this.targets.definition(comment.targetType).writeScope);
    return { comment, role };
  }

  private async requireTargetState(connection: Connection, target: CommentTarget) {
    const state = await this.targets
      .definition(target.targetType)
      .findState(connection, { projectId: target.projectId, targetId: target.targetId });
    if (!state) notFound('コメントの対象');
    return state;
  }

  // Replies stay one level deep: a reply to a reply joins the thread of the original root.
  private async threadRootId(
    connection: Connection,
    parent: CommentTarget & { commentId: string },
  ): Promise<string> {
    const comment = await findComment(connection, parent);
    if (!comment) notFound('返信先のComment');
    if (comment.targetType !== parent.targetType || comment.targetId !== parent.targetId)
      throw new DomainError(
        422,
        '返信先のコメントは同じ対象に付いていません',
        'comment_parent_mismatch',
      );
    return comment.parentCommentId ?? comment.id;
  }
}
