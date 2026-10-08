import type { EvaluationComparison } from '@mmt/contracts';
import { encodeId, projectPath, request } from './http';

export interface EvaluationComparisonQuery {
  baselineAlias?: string;
  baselineVersionId?: string;
  // Omitted conditions are taken by the API from the candidate's latest evaluation Run.
  referenceDatasetVersionIds?: string[];
  codeVersionId?: string;
  evaluationRuleId?: string;
  metrics?: string[];
}

function comparisonSearch(query: EvaluationComparisonQuery): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // An empty list is sent as an empty parameter: it means "no reference datasets", not "any".
    search.set(name, Array.isArray(value) ? value.join(',') : value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export const evaluationApi = {
  comparison: (
    target: { projectId: string; modelId: string; candidateVersionId: string },
    query: EvaluationComparisonQuery,
    signal?: AbortSignal,
  ) =>
    request<EvaluationComparison>(
      `${projectPath(target.projectId)}/models/${encodeId(target.modelId)}/versions/${encodeId(
        target.candidateVersionId,
      )}/evaluation-comparison${comparisonSearch(query)}`,
      { signal },
    ),
};
