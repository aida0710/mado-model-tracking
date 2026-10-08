import { findReportArchiveState } from '../repositories/reportRepository.js';
import type { CommentTargetDefinition } from './commentTargets.js';

/**
 * Comments on a report. An archived report keeps its comments readable but takes no new ones
 * (409 comment_target_deleted), like a deleted Run. Writing needs the same scope as editing.
 */
export const reportCommentTarget: CommentTargetDefinition = {
  writeScope: 'runs:write',
  async findState(connection, target) {
    const report = await findReportArchiveState(connection, {
      projectId: target.projectId,
      reportId: target.targetId,
    });
    if (!report) return undefined;
    return report.archived ? 'deleted' : 'active';
  },
};
