import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  Experiment,
  Model,
  ModelVersion,
  Run,
} from '@mmt/contracts';

export interface ExecutionCatalog {
  experiments: Experiment[];
  models: Model[];
  codes: Code[];
  datasets: Dataset[];
  runs: Run[];
  modelVersions: ModelVersion[];
  codeVersions: CodeVersion[];
  datasetVersions: DatasetVersion[];
}
