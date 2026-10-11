import type { ComputeTargetOverview } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { useMutation } from './useMutation';
import { useQuery } from './useQuery';

/**
 * 全体設定 → コンピュータ: every computer (GET /targets/overview) and the details of those one may
 * use or manage (GET /targets), reloaded together after a change.
 */
export function useComputers() {
  const overview = useQuery('compute-target-overview', executionApi.targetOverview);
  const details = useQuery('compute-targets', executionApi.targets);
  const mutation = useMutation();
  function reload() {
    overview.reload();
    details.reload();
  }
  function toggleEnabled(target: Pick<ComputeTargetOverview, 'id' | 'enabled'>) {
    void mutation
      .run(() => executionApi.updateTarget(target.id, { enabled: !target.enabled }))
      .then((saved) => {
        if (saved) reload();
      });
  }
  /** The full computer for a row one may open; undefined until GET /targets has it. */
  const findDetails = (targetId: string | null) =>
    details.value?.find((target) => target.id === targetId);
  return { overview, findDetails, reload, toggleEnabled, mutation };
}
