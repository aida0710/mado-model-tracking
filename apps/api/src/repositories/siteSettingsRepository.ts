import type { SiteJobShellSummary, SiteSettings } from '@mmt/contracts';
import { rows, type Connection } from '../db/database.js';
import type { SiteSettingsValues } from '../domain/siteSettingsValidation.js';

interface SiteSettingsRow {
  targetId: string;
  launcherId: string | null;
  connectionHost: string | null;
  connectionPort: number;
  jumpHosts: string[];
  knownHosts: string;
  accountMode: SiteSettings['accountMode'];
  sharedAccount: string;
  workDirectory: string;
  runnerPython: string;
  runnerApiUrl: string | null;
  cancelCommand: string | null;
  gpuAssignment: SiteSettings['gpuAssignment'];
  leaseGpuIds: string[];
  variables: Record<string, string>;
  cancelGraceSeconds: number;
  maxOutputFiles: number;
  maxActiveSubmissions: number;
  jobShellId: string | null;
  jobShellVersion: number | null;
  jobShellSha256: string | null;
  jobShellSizeBytes: number | null;
  jobShellCreatedBy: string | null;
  jobShellCreatedByName: string | null;
  jobShellCreatedAt: string | null;
}

const settingsSelect = `SELECT s.target_id,s.launcher_id,s.connection_host,s.connection_port,s.jump_hosts,
  s.known_hosts,s.account_mode,s.shared_account,s.work_directory,s.runner_python,s.runner_api_url,
  s.cancel_command,s.gpu_assignment,s.lease_gpu_ids,s.variables,s.cancel_grace_seconds,s.max_output_files,
  s.max_active_submissions,j.id AS job_shell_id,j.version AS job_shell_version,j.sha256 AS job_shell_sha256,
  octet_length(j.content) AS job_shell_size_bytes,j.created_by AS job_shell_created_by,
  u.display_name AS job_shell_created_by_name,j.created_at AS job_shell_created_at
  FROM site_settings s LEFT JOIN site_job_shells j ON j.id=s.current_job_shell_id
  LEFT JOIN users u ON u.id=j.created_by`;

function currentJobShell(row: SiteSettingsRow): SiteJobShellSummary | null {
  if (!row.jobShellId) return null;
  return {
    id: row.jobShellId,
    targetId: row.targetId,
    version: row.jobShellVersion!,
    sha256: row.jobShellSha256!,
    sizeBytes: row.jobShellSizeBytes!,
    createdBy: row.jobShellCreatedBy!,
    createdByName: row.jobShellCreatedByName,
    createdAt: row.jobShellCreatedAt!,
  };
}

function toSiteSettings(row: SiteSettingsRow): SiteSettings {
  return {
    launcherId: row.launcherId,
    connection: row.connectionHost
      ? {
          host: row.connectionHost,
          port: row.connectionPort,
          jumpHosts: row.jumpHosts,
          knownHosts: row.knownHosts,
        }
      : null,
    accountMode: row.accountMode,
    sharedAccount: row.sharedAccount,
    workDirectory: row.workDirectory,
    runnerPython: row.runnerPython,
    runnerApiUrl: row.runnerApiUrl,
    cancelCommand: row.cancelCommand,
    gpuAssignment: row.gpuAssignment,
    leaseGpuIds: row.leaseGpuIds,
    variables: row.variables,
    cancelGraceSeconds: row.cancelGraceSeconds,
    maxOutputFiles: row.maxOutputFiles,
    maxActiveSubmissions: row.maxActiveSubmissions,
    jobShell: currentJobShell(row),
  };
}

/** The settings of these sites, by target ID; a site without a row (not a site) is absent. */
export async function listSiteSettings(
  connection: Connection,
  targetIds: readonly string[],
): Promise<Map<string, SiteSettings>> {
  if (!targetIds.length) return new Map();
  const found = await rows<SiteSettingsRow>(
    connection,
    `${settingsSelect} WHERE s.target_id=ANY($1::uuid[])`,
    [targetIds],
  );
  return new Map(found.map((row) => [row.targetId, toSiteSettings(row)]));
}

export async function findSiteSettings(
  connection: Connection,
  targetId: string,
): Promise<SiteSettings | undefined> {
  return (await listSiteSettings(connection, [targetId])).get(targetId);
}

/** Every automatic site this launcher submits to, with its settings. */
export async function listLauncherSiteSettings(
  connection: Connection,
  launcherId: string,
): Promise<Map<string, SiteSettings>> {
  const found = await rows<SiteSettingsRow>(
    connection,
    `${settingsSelect} JOIN compute_targets t ON t.id=s.target_id
    WHERE s.launcher_id=$1 AND t.executor='site' AND t.submission_mode='automatic' AND t.enabled
    ORDER BY t.name,t.id`,
    [launcherId],
  );
  return new Map(found.map((row) => [row.targetId, toSiteSettings(row)]));
}

function settingsParameters(settings: SiteSettingsValues): unknown[] {
  return [
    settings.launcherId,
    settings.connection?.host ?? null,
    settings.connection?.port ?? 22,
    settings.connection?.jumpHosts ?? [],
    settings.connection?.knownHosts ?? '',
    settings.accountMode,
    settings.sharedAccount,
    settings.workDirectory,
    settings.runnerPython,
    settings.runnerApiUrl,
    settings.cancelCommand,
    settings.gpuAssignment,
    settings.leaseGpuIds,
    JSON.stringify(settings.variables),
    settings.cancelGraceSeconds,
    settings.maxOutputFiles,
    settings.maxActiveSubmissions,
  ];
}

export async function saveSiteSettings(
  connection: Connection,
  site: { targetId: string; settings: SiteSettingsValues; updatedBy: string },
): Promise<void> {
  await connection.query(
    `INSERT INTO site_settings(target_id,updated_by,launcher_id,connection_host,connection_port,jump_hosts,
      known_hosts,account_mode,shared_account,work_directory,runner_python,runner_api_url,cancel_command,
      gpu_assignment,lease_gpu_ids,variables,cancel_grace_seconds,max_output_files,max_active_submissions)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19)
    ON CONFLICT (target_id) DO UPDATE SET updated_by=$2,launcher_id=$3,connection_host=$4,connection_port=$5,
      jump_hosts=$6,known_hosts=$7,account_mode=$8,shared_account=$9,work_directory=$10,runner_python=$11,
      runner_api_url=$12,cancel_command=$13,gpu_assignment=$14,lease_gpu_ids=$15,variables=$16::jsonb,
      cancel_grace_seconds=$17,max_output_files=$18,max_active_submissions=$19,updated_at=now()`,
    [site.targetId, site.updatedBy, ...settingsParameters(site.settings)],
  );
}

/** Serializes job shell versions and settings changes of one site. */
export async function lockSiteSettings(connection: Connection, targetId: string): Promise<void> {
  await connection.query('SELECT 1 FROM site_settings WHERE target_id=$1 FOR UPDATE', [targetId]);
}

export function siteSettingsValues(settings: SiteSettings): SiteSettingsValues {
  const { jobShell: _jobShell, ...values } = settings;
  return values;
}
