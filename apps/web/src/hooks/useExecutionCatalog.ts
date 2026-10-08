import type { ExecutionCatalog } from '../types/executionCatalog';
import { registryApi } from '../api/registry';
import { trackingApi } from '../api/tracking';
import { useQuery } from './useQuery';

// Registry selectors use the same bounded list as the Run browser.
export const RUN_LIST_LIMIT = 500;
export function useExecutionCatalog(projectId: string) {
  return useQuery<ExecutionCatalog>(`${projectId}:execution-catalog`, async (signal) => {
    const [experiments, models, codes, datasets, runs] = await Promise.all([
      trackingApi.experiments(projectId, signal),
      registryApi.models(projectId, signal),
      registryApi.codes(projectId, signal),
      registryApi.datasets(projectId, signal),
      trackingApi.runs(projectId, { limit: String(RUN_LIST_LIMIT) }, signal),
    ]);
    const [modelVersions, codeVersions, datasetVersions] = await Promise.all([
      Promise.all(models.map((model) => registryApi.modelVersions(projectId, model.id, signal))),
      Promise.all(codes.map((code) => registryApi.codeVersions(projectId, code.id, signal))),
      Promise.all(
        datasets.map((dataset) => registryApi.datasetVersions(projectId, dataset.id, signal)),
      ),
    ]);
    return {
      experiments,
      models,
      codes,
      datasets,
      runs,
      modelVersions: modelVersions.flat(),
      codeVersions: codeVersions.flat(),
      datasetVersions: datasetVersions.flat(),
    };
  });
}
