import { useState } from 'react';
import { evaluationApi } from '../api/evaluation';
import { defaultBaselineAlias } from '../lib/evaluationComparisonDisplay';
import { useQuery } from './useQuery';

export function useEvaluationComparison(target: {
  projectId: string;
  modelId: string;
  candidateVersionId: string;
  aliases: Record<string, string>;
}) {
  const { projectId, modelId, candidateVersionId } = target;
  const [chosenAlias, setChosenAlias] = useState<string | null>(null);
  // A chosen alias that was removed from the model falls back to the default again.
  const baselineAlias =
    chosenAlias !== null && Object.hasOwn(target.aliases, chosenAlias)
      ? chosenAlias
      : defaultBaselineAlias(target.aliases);
  const comparison = useQuery(
    `${projectId}:${modelId}:${candidateVersionId}:evaluation-comparison:${baselineAlias ?? ''}`,
    (signal) =>
      evaluationApi.comparison(
        { projectId, modelId, candidateVersionId },
        { baselineAlias: baselineAlias ?? undefined },
        signal,
      ),
  );
  return { baselineAlias, selectBaselineAlias: setChosenAlias, comparison };
}
