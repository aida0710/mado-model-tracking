import { promotionApi } from '../api/promotion';
import { registryApi } from '../api/registry';
import { useQuery } from './useQuery';

/**
 * What deciding a promotion of one Model's version needs: the Model's policies (which alias each
 * one targets), the alias protections that apply to the Model, and the decisions about the version.
 */
export function usePromotionChoices(projectId: string, modelId: string, versionId: string) {
  const policies = useQuery(`${projectId}:promotion-policies:${modelId}`, async (signal) =>
    (await promotionApi.policies(projectId, signal)).filter((policy) => policy.modelId === modelId),
  );
  const protections = useQuery(`${projectId}:alias-protections:${modelId}`, (signal) =>
    registryApi.aliasProtections(projectId, modelId, signal),
  );
  // The newest page is enough: a version gets one decision per policy and evaluation Run.
  const decisions = useQuery(
    versionId ? `${projectId}:promotion-evaluations:${versionId}` : null,
    async (signal) =>
      (await promotionApi.evaluations(projectId, { candidateVersionId: versionId, signal })).items,
  );
  return {
    policies,
    protections,
    decisions,
    reload: () => {
      policies.reload();
      protections.reload();
      decisions.reload();
    },
  };
}
