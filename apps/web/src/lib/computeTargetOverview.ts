import type { ComputeTargetOverview } from '@mmt/contracts';
import { formatDate } from './format';
import { text, textTemplates } from '../i18n/catalog';

/**
 * Whether a row of 全体設定 → コンピュータ opens its details: for those who may use the computer
 * (its job shell and their own settings) or manage it. Someone else's private computer stays a row.
 */
export const canOpenTargetDetails = (
  target: Pick<ComputeTargetOverview, 'usable' | 'canManage'>,
): boolean => target.usable || target.canManage;

/**
 * How the launcher of an automatic site stands, for the state column: none chosen, revoked, never
 * heard from, or when it last asked. Other computers have no launcher to report (null).
 */
export function launcherStatusLabel(
  target: Pick<ComputeTargetOverview, 'executor' | 'submissionMode' | 'launcher'>,
): string | null {
  if (target.executor !== 'site' || target.submissionMode !== 'automatic') return null;
  const { launcher } = target;
  if (!launcher) return text.computerLauncherMissing;
  if (launcher.revoked) return text.computerLauncherRevoked;
  if (!launcher.lastSeenAt) return text.computerLauncherNeverSeen;
  return textTemplates.computerLauncherSeen(launcher.name, formatDate(launcher.lastSeenAt));
}
