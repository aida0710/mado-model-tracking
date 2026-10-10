import type { ComputeTargetDetails, User } from '@mmt/contracts';
import { ManualSubmissionGuide } from './ManualSubmissionNotice';
import { SiteJobShellPanel } from './SiteJobShellPanel';
import { SitePersonalSettingsPanel } from './SitePersonalSettingsPanel';
import { SitePersonalSettingsTable } from './SitePersonalSettingsTable';
import { SiteSharedKeyPanel } from './SiteSharedKeyPanel';
import { canManageTarget, isTargetOwner } from '../lib/permissions';
import { personalSettingsScope } from '../lib/sitePersonalSettingsInput';

/**
 * A site's details below the Compute list. Everyone who may use it reads its job shell, keeps
 * their own settings (and key, where the launcher logs in as each person) and, on a manual site,
 * sees how to submit. Its owner and global administrators also save job shell versions, authorize
 * the shared account's key and see everyone's settings.
 */
export function SiteComputerDetails({
  target,
  user,
  onTargetChanged,
}: {
  target: ComputeTargetDetails;
  user: Pick<User, 'id' | 'isAdmin'>;
  onTargetChanged: () => void;
}) {
  const canManage = canManageTarget(user, target);
  const isAutomatic = target.submissionMode === 'automatic';
  return (
    <section className="settings-section site-computer" data-testid="site-computer-details">
      <div className="section-heading">
        <h2>{target.name}</h2>
      </div>
      {!isAutomatic && (
        <ManualSubmissionGuide targetId={target.id} isOwner={isTargetOwner(user, target)} />
      )}
      <SiteJobShellPanel targetId={target.id} canEdit={canManage} onSaved={onTargetChanged} />
      {isAutomatic && canManage && target.siteAccountMode === 'shared' && (
        <SiteSharedKeyPanel target={target} userId={user.id} />
      )}
      <SitePersonalSettingsPanel target={target} userId={user.id} />
      {canManage && personalSettingsScope(target) !== 'none' && (
        <SitePersonalSettingsTable targetId={target.id} />
      )}
    </section>
  );
}
