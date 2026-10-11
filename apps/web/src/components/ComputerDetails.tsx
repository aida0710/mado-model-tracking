import type { ComputeTargetDetails, User } from '@mmt/contracts';
import { ComputeTargetKind } from './ComputeTargetKind';
import { DetailsList } from './JsonDetails';
import { SiteComputerDetails } from './SiteComputerDetails';
import { TargetCheckPanel } from './TargetCheckPanel';
import { formatTargetGpus, formatTargetLocation } from '../lib/computeTargetDisplay';
import { canManageTarget } from '../lib/permissions';
import { text } from '../i18n/catalog';
import { runtimeLabels } from '../i18n/runtime';

/**
 * A computer's details below 全体設定 → コンピュータ, for those who may use or manage it: a site's
 * job shell, settings and submission; an ssh or local target's description, and its connection
 * check for its owner and global administrators.
 */
export function ComputerDetails({
  target,
  user,
  onTargetChanged,
}: {
  target: ComputeTargetDetails;
  user: Pick<User, 'id' | 'isAdmin'>;
  onTargetChanged: () => void;
}) {
  if (target.executor === 'site')
    return <SiteComputerDetails target={target} user={user} onTargetChanged={onTargetChanged} />;
  return (
    <>
      <section className="settings-section" data-testid="computer-summary">
        <div className="section-heading">
          <h2>{target.name}</h2>
        </div>
        <DetailsList
          entries={[
            [text.computerKind, <ComputeTargetKind target={target} />],
            [text.computerLocation, <span className="mono">{formatTargetLocation(target)}</span>],
            [text.runtimeKinds, target.runtimeKinds.map((kind) => runtimeLabels[kind]).join(', ')],
            [text.gpuIds, formatTargetGpus(target)],
            [text.maxConcurrentJobs, String(target.maxConcurrentJobs)],
          ]}
        />
      </section>
      {canManageTarget(user, target) && (
        <TargetCheckPanel target={target} onTargetSaved={onTargetChanged} />
      )}
    </>
  );
}
