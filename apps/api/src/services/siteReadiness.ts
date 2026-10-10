import type { ComputeTarget, SiteSettings, SiteSubmissionAccount } from '@mmt/contracts';
import type { Connection } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { isLiveLauncher } from '../repositories/launcherRepository.js';
import { findLiveSiteKey } from '../repositories/siteKeyRepository.js';
import { findPersonalSettings } from '../repositories/sitePersonalSettingsRepository.js';
import { findSiteSettings } from '../repositories/siteSettingsRepository.js';
import { canUseTarget } from './siteAccess.js';

function notReady(message: string, code: string): never {
  throw new DomainError(422, message, code);
}

/**
 * Checked when a Job is created (and when a rule, hook, Task or Sweep names the computer): the
 * Run's creator may use the computer in its Project, and a site has what a submission needs.
 * The launcher's key is not checked here; it may be made or registered later.
 */
export async function assertTargetReadyForJobs(
  connection: Connection,
  usage: { target: ComputeTarget; projectId: string; userId: string },
): Promise<void> {
  const { target } = usage;
  if (!(await canUseTarget(connection, { targetId: target.id, userId: usage.userId, projectId: usage.projectId })))
    notReady('この計算機はこのProjectでは使えません（所有者が共有していません）', 'target_not_available');
  if (target.executor !== 'site') return;
  const settings = await findSiteSettings(connection, target.id);
  if (!settings?.jobShell) notReady('この計算機にはjob shellがありません', 'site_job_shell_missing');
  if (target.submissionMode !== 'automatic') return;
  if (!settings.launcherId || !(await isLiveLauncher(connection, settings.launcherId)))
    notReady('この計算機を投入するlauncherがありません', 'site_launcher_missing');
  if (settings.accountMode === 'personal') {
    const personal = await findPersonalSettings(connection, { targetId: target.id, userId: usage.userId });
    if (!personal?.accountName)
      notReady(
        'この計算機は本人のアカウントで動きます。計算機の「自分の設定」でアカウント名を登録してください',
        'site_account_required',
      );
  }
}

function submissionFailure(message: string): never {
  throw new DomainError(422, message, 'site_submission_unready');
}

/**
 * Whose account one job shell call runs as. A launcher logs in as the shared account or as the
 * requester with the launcher's key for them; a manual submission runs as whoever submits, with
 * their own work directory and variables. A DomainError fails the submission with its message.
 */
export async function resolveSubmissionAccount(
  connection: Connection,
  submission: {
    target: ComputeTarget;
    settings: SiteSettings;
    requesterId: string;
    submittingUserId: string | null;
  },
): Promise<SiteSubmissionAccount> {
  const { target, settings } = submission;
  if (target.submissionMode === 'automatic') {
    const userId = settings.accountMode === 'shared' ? null : submission.requesterId;
    const personal = userId
      ? await findPersonalSettings(connection, { targetId: target.id, userId })
      : undefined;
    if (userId && !personal?.accountName)
      submissionFailure('依頼した人のこの計算機の個人設定（アカウント名）がありません');
    const key = await findLiveSiteKey(connection, { targetId: target.id, userId });
    if (!key || key.status !== 'ready')
      submissionFailure('launcherがこのアカウントの鍵をまだ作っていません');
    const workDirectory = personal?.workDirectory || settings.workDirectory;
    if (!workDirectory) submissionFailure('この計算機の作業ディレクトリが決まっていません');
    return {
      mode: settings.accountMode,
      accountName: personal?.accountName ?? settings.sharedAccount,
      workDirectory,
      variables: { ...settings.variables, ...personal?.variables },
      keyId: key.id,
    };
  }
  const personal = await findPersonalSettings(connection, {
    targetId: target.id,
    userId: submission.submittingUserId ?? submission.requesterId,
  });
  return {
    mode: 'personal',
    accountName: '',
    workDirectory: personal?.workDirectory || settings.workDirectory,
    variables: { ...settings.variables, ...personal?.variables },
    keyId: null,
  };
}
