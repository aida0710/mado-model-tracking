import { createHash } from 'node:crypto';
import type { SiteJobShell, SiteJobShellSummary } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

const summaryColumns = `j.id,j.target_id,j.version,j.sha256,octet_length(j.content) AS size_bytes,
  j.created_by,u.display_name AS created_by_name,j.created_at`;
const fromJobShells = 'FROM site_job_shells j LEFT JOIN users u ON u.id=j.created_by';

export function jobShellSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Newest first. */
export async function listJobShells(
  connection: Connection,
  targetId: string,
): Promise<SiteJobShellSummary[]> {
  return rows<SiteJobShellSummary>(
    connection,
    `SELECT ${summaryColumns} ${fromJobShells} WHERE j.target_id=$1 ORDER BY j.version DESC`,
    [targetId],
  );
}

export async function findJobShell(
  connection: Connection,
  reference: { targetId: string; id: string },
): Promise<SiteJobShell | undefined> {
  return first<SiteJobShell>(
    connection,
    `SELECT ${summaryColumns},j.content ${fromJobShells} WHERE j.target_id=$1 AND j.id=$2`,
    [reference.targetId, reference.id],
  );
}

export async function findCurrentJobShell(
  connection: Connection,
  targetId: string,
): Promise<SiteJobShell | undefined> {
  return first<SiteJobShell>(
    connection,
    `SELECT ${summaryColumns},j.content ${fromJobShells}
    JOIN site_settings s ON s.current_job_shell_id=j.id WHERE s.target_id=$1`,
    [targetId],
  );
}

/** Adds the next version and makes it the site's current one; the caller holds the site lock. */
export async function insertJobShell(
  connection: Connection,
  shell: { targetId: string; content: string; createdBy: string },
): Promise<SiteJobShell> {
  const inserted = (await first<{ id: string }>(
    connection,
    `INSERT INTO site_job_shells(target_id,version,content,sha256,created_by)
    SELECT $1,COALESCE(max(version),0)+1,$2,$3,$4 FROM site_job_shells WHERE target_id=$1 RETURNING id`,
    [shell.targetId, shell.content, jobShellSha256(shell.content), shell.createdBy],
  ))!;
  await connection.query('UPDATE site_settings SET current_job_shell_id=$2 WHERE target_id=$1', [
    shell.targetId,
    inserted.id,
  ]);
  return (await findJobShell(connection, { targetId: shell.targetId, id: inserted.id }))!;
}
