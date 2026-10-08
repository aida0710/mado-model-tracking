import { evaluationApi } from '../api/evaluation';
import { encodeBaselineChoice, type BaselineChoice } from '../lib/evaluationBaseline';
import { useQuery } from './useQuery';

/** The comparison of a version with the chosen baseline. A null choice lets the API use production. */
export function useEvaluationComparison(target: {
  projectId: string;
  modelId: string;
  candidateVersionId: string;
  baseline: BaselineChoice | null;
}) {
  const { projectId, modelId, candidateVersionId, baseline } = target;
  const comparison = useQuery(
    `${projectId}:${modelId}:${candidateVersionId}:evaluation-comparison:${encodeBaselineChoice(baseline)}`,
    (signal) =>
      evaluationApi.comparison(
        { projectId, modelId, candidateVersionId },
        baseline?.kind === 'version'
          ? { baselineVersionId: baseline.versionId }
          : { baselineAlias: baseline?.alias },
        signal,
      ),
  );
  return { comparison };
}
