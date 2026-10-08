import type { ExecutionRuntimeKind } from '@mmt/contracts';

export const runtimeLabels: Record<ExecutionRuntimeKind, string> = {
  python: 'Python',
  docker: 'Docker',
  singularity: 'Singularity',
  apptainer: 'Apptainer',
};
