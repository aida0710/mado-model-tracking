import type { ExecutionCatalog } from '../hooks/useExecutionCatalog';
import type { SelectOption } from '../components/FormFields';
import { text } from '../i18n/catalog';

export function buildCatalogOptions(catalog: ExecutionCatalog) {
  return {
    experiments: catalog.experiments.map((item) => ({ value: item.id, label: item.name })),
    models: catalog.modelVersions.map((item) => ({
      value: item.id,
      label: `${catalog.models.find((model) => model.id === item.modelId)?.name ?? item.modelId} / ${item.version} · ${item.family}`,
    })),
    codes: catalog.codeVersions.map((item) => ({
      value: item.id,
      label: `${catalog.codes.find((code) => code.id === item.codeId)?.name ?? item.codeId} / ${item.version}`,
    })),
    datasets: catalog.datasetVersions.map((item) => ({
      value: item.id,
      label: `${item.namespace}/${item.name} / ${item.version}`,
    })),
    runs: catalog.runs.map((item) => ({ value: item.id, label: item.name })),
  };
}
export const withEmptyOption = (options: SelectOption[]): SelectOption[] => [
  { value: '', label: text.none },
  ...options,
];
