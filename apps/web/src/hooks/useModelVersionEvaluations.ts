import type { ModelVersionDetail } from '@mmt/contracts';
import { promotionApi } from '../api/promotion';
import { registryApi } from '../api/registry';
import { hasActiveRun } from '../lib/automationActivity';
import { defaultBaselineAlias } from '../lib/evaluationComparisonDisplay';
import { useCursorPages } from './useCursorPages';
import { useQuery } from './useQuery';
import { useQueryPolledWhileActive } from './useQueryPolledWhileActive';

/**
 * The Runs that used a version, the baseline version's evaluations to compare them with, and the
 * promotion decisions made for the version. Pass detail undefined until the version is loaded.
 */
export function useModelVersionEvaluations(
  projectId: string,
  detail: ModelVersionDetail | undefined,
) {
  const versionId = detail?.version.id ?? null;
  const results = useQueryPolledWhileActive(
    versionId ? `${projectId}:model-version:${versionId}:evaluations` : null,
    (signal) => registryApi.modelVersionEvaluations(projectId, versionId!, { signal }),
    (page) => hasActiveRun(page.items),
  );
  const baselineAlias = detail ? defaultBaselineAlias(detail.model.aliases) : null;
  const baselineVersionId = baselineAlias ? (detail?.model.aliases[baselineAlias] ?? null) : null;
  // The version compared with itself has no difference to show.
  const comparedVersionId = baselineVersionId !== versionId ? baselineVersionId : null;
  const baselineResults = useQuery(
    comparedVersionId ? `${projectId}:model-version:${comparedVersionId}:evaluations` : null,
    (signal) =>
      registryApi.modelVersionEvaluations(projectId, comparedVersionId!, {
        kind: 'evaluation',
        signal,
      }),
  );
  const promotionEvaluations = useCursorPages(
    versionId ? `${projectId}:promotion-evaluations:candidate:${versionId}` : null,
    (cursor, signal) =>
      promotionApi.evaluations(projectId, { candidateVersionId: versionId!, cursor, signal }),
  );
  return {
    results,
    baseline: { alias: baselineAlias, versionId: comparedVersionId, results: baselineResults },
    promotionEvaluations,
  };
}
