import type { ComputeTargetOverview } from '@mmt/contracts';
import { rows, type Connection } from '../db/database.js';

/**
 * Whose Jobs may run on a computer, in SQL over compute_targets `t`: everyone's on a public one;
 * on a private one its owner's, and those of the Service Accounts its owner created. $user is
 * whom the Jobs run as (a Run's creator, or a rule's, hook's, Task's or Sweep's owner).
 */
export function targetUsableSql(user: string): string {
  return `(t.visibility='public' OR t.owner_user_id=${user} OR EXISTS(
    SELECT 1 FROM service_account_details sa WHERE sa.user_id=${user} AND sa.created_by=t.owner_user_id))`;
}

/** An overview row before the caller's management right, which the service decides. */
export type TargetOverviewRow = Omit<ComputeTargetOverview, 'canManage' | 'launcher'> & {
  launcherName: string | null;
  launcherLastSeenAt: string | null;
  launcherRevokedAt: string | null;
};

/**
 * Every computer with whether `userId` may run Jobs on it, and for an automatic site the
 * launcher that submits its Jobs. No column says how a computer is reached.
 */
export async function listTargetOverviewRows(
  connection: Connection,
  userId: string,
): Promise<TargetOverviewRow[]> {
  return rows<TargetOverviewRow>(
    connection,
    `SELECT t.id,t.name,t.executor,t.submission_mode,t.cpu_arch,t.supports_array,t.enabled,
      t.visibility,t.owner_user_id,o.display_name AS owner_name,${targetUsableSql('$1::uuid')} AS usable,
      l.name AS launcher_name,l.last_seen_at AS launcher_last_seen_at,l.revoked_at AS launcher_revoked_at
    FROM compute_targets t LEFT JOIN users o ON o.id=t.owner_user_id
    LEFT JOIN site_settings s ON s.target_id=t.id AND t.executor='site' AND t.submission_mode='automatic'
    LEFT JOIN launchers l ON l.id=s.launcher_id
    ORDER BY t.name,t.id`,
    [userId],
  );
}
