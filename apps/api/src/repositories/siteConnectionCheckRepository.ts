import { SITE_CONNECTION_CHECK_TIMEOUT_SECONDS, type SiteConnectionCheck } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

// The Compute page shows recent history only.
const CHECK_LIST_LIMIT = 10;
const checkColumns = 'id,target_id,user_id,requested_by,status,message,created_at,finished_at';
const NO_LAUNCHER_MESSAGE = 'launcherが応答しませんでした（止まっているか、このコンピュータの担当ではありません）';

/** Checks no launcher answered in time fail, so a stopped launcher is visible. */
export async function expireStaleConnectionChecks(connection: Connection): Promise<void> {
  await connection.query(
    `UPDATE site_connection_checks SET status='failed',message=$2,finished_at=now()
    WHERE status='queued' AND created_at<now()-make_interval(secs=>$1)`,
    [SITE_CONNECTION_CHECK_TIMEOUT_SECONDS, NO_LAUNCHER_MESSAGE],
  );
}

/** undefined: a check of this account is already waiting. */
export async function insertConnectionCheck(
  connection: Connection,
  check: { targetId: string; userId: string | null; requestedBy: string },
): Promise<SiteConnectionCheck | undefined> {
  return first<SiteConnectionCheck>(
    connection,
    `INSERT INTO site_connection_checks(target_id,user_id,requested_by) VALUES($1,$2,$3)
    ON CONFLICT (target_id,COALESCE(user_id,'00000000-0000-0000-0000-000000000000'::uuid))
      WHERE status='queued' DO NOTHING
    RETURNING ${checkColumns}`,
    [check.targetId, check.userId, check.requestedBy],
  );
}

export async function listConnectionChecks(
  connection: Connection,
  account: { targetId: string; userId: string | null },
): Promise<SiteConnectionCheck[]> {
  return rows<SiteConnectionCheck>(
    connection,
    `SELECT ${checkColumns} FROM site_connection_checks
    WHERE target_id=$1 AND user_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC,id DESC LIMIT $3`,
    [account.targetId, account.userId, CHECK_LIST_LIMIT],
  );
}

/** Waiting checks of the sites this launcher submits to. */
export async function listLauncherConnectionChecks(
  connection: Connection,
  launcherId: string,
): Promise<{ id: string; targetId: string; userId: string | null }[]> {
  return rows(
    connection,
    `SELECT c.id,c.target_id,c.user_id FROM site_connection_checks c
    JOIN site_settings s ON s.target_id=c.target_id
    WHERE c.status='queued' AND s.launcher_id=$1 ORDER BY c.created_at,c.id`,
    [launcherId],
  );
}

/** false: the check already ended, or belongs to another launcher's site. */
export async function finishConnectionCheck(
  connection: Connection,
  result: { checkId: string; launcherId: string; succeeded: boolean; message: string | null },
): Promise<boolean> {
  const finished = await connection.query(
    `UPDATE site_connection_checks c SET status=$3,message=$4,finished_at=now()
    FROM site_settings s WHERE c.id=$1 AND c.status='queued' AND s.target_id=c.target_id AND s.launcher_id=$2`,
    [result.checkId, result.launcherId, result.succeeded ? 'succeeded' : 'failed', result.message],
  );
  return (finished.rowCount ?? 0) > 0;
}
