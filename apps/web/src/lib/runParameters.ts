import type { JsonObject, Run } from '@mmt/contracts';

export function getRunParameters(run: Pick<Run, 'parameters' | 'recordedParameters'>): JsonObject {
  // SDK strings describe the same pinned values; keep native types for comparisons.
  return { ...run.recordedParameters, ...run.parameters };
}
