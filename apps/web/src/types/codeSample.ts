import type { RunKind } from '@mmt/contracts';

export interface CodeSample {
  id: 'smoke' | 'sdk' | 'mlflow' | 'inference' | 'training';
  label: string;
  files: Record<string, string>;
  entrypoint: string[];
  testEntrypoint: string[];
  requirements: string[];
  families: string[];
  taskTypes: RunKind[];
}
