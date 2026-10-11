import type { ComputeTargetDetails, User } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { ComputeTargetKind } from './ComputeTargetKind';
import { ComputeTargetState } from './ComputeTargetState';
import { VisibilityLabel } from './VisibilityLabel';
import { formatTargetGpus, formatTargetLocation } from '../lib/computeTargetDisplay';
import { targetOwnerLabel } from '../lib/siteComputerDisplay';
import { text } from '../i18n/catalog';
import { runtimeLabels } from '../i18n/runtime';

/**
 * The computers one may run Jobs on, for the Project's Compute page: read only, since adding and
 * managing them is in 全体設定 → コンピュータ. Where one is reached shows only for its managers.
 */
export function ComputeTargetsTable({
  targets,
  user,
}: {
  targets: ComputeTargetDetails[];
  user: Pick<User, 'id'>;
}) {
  return (
    <ResponsiveTable
      rows={targets}
      rowKey={(target) => target.id}
      empty={text.noComputers}
      columns={[
        { key: 'name', priority: 'primary', header: text.name, render: (target) => target.name },
        {
          key: 'kind',
          priority: 'secondary',
          header: text.computerKind,
          render: (target) => <ComputeTargetKind target={target} />,
        },
        {
          key: 'owner',
          priority: 'secondary',
          header: text.computerOwner,
          render: (target) => targetOwnerLabel(target, user.id),
        },
        {
          key: 'visibility',
          priority: 'secondary',
          header: text.computerVisibility,
          render: (target) => <VisibilityLabel visibility={target.visibility} />,
        },
        {
          key: 'host',
          priority: 'secondary',
          header: text.host,
          className: 'mono',
          render: (target) => formatTargetLocation(target),
        },
        {
          key: 'runtime',
          priority: 'secondary',
          header: text.runtimeKinds,
          render: (target) => target.runtimeKinds.map((kind) => runtimeLabels[kind]).join(', '),
        },
        {
          key: 'gpu',
          priority: 'secondary',
          header: text.gpuIds,
          className: 'mono',
          render: (target) => formatTargetGpus(target),
        },
        {
          key: 'concurrent',
          priority: 'secondary',
          header: text.maxConcurrentJobs,
          className: 'mono',
          render: (target) => target.maxConcurrentJobs,
        },
        {
          key: 'state',
          priority: 'primary',
          header: text.computerState,
          render: (target) => <ComputeTargetState enabled={target.enabled} />,
        },
      ]}
    />
  );
}
