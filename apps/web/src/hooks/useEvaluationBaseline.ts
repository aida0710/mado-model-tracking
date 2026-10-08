import { useState } from 'react';
import type { ModelVersion } from '@mmt/contracts';
import {
  baselineVersionIdOf,
  defaultBaselineChoice,
  isBaselineChoiceAvailable,
  type BaselineChoice,
} from '../lib/evaluationBaseline';

/**
 * The baseline the version page compares with, shared by the metric summary and the comparison
 * panel. A choice whose alias was removed or whose version is gone falls back to the default.
 */
export function useEvaluationBaseline(model: {
  aliases: Record<string, string>;
  candidateVersionId: string;
  versions: readonly ModelVersion[];
}) {
  const [chosen, setChosen] = useState<BaselineChoice | null>(null);
  const isDefault = !chosen || !isBaselineChoiceAvailable(chosen, model);
  const choice = isDefault ? defaultBaselineChoice(model) : chosen;
  return {
    choice,
    isDefault,
    versionId: baselineVersionIdOf(choice, model.aliases),
    select: setChosen,
  };
}

export type EvaluationBaseline = ReturnType<typeof useEvaluationBaseline>;
