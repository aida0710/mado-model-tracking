export type ExecutionRuntimeKind = 'python' | 'docker' | 'singularity' | 'apptainer';

export type ExecutionRuntime =
  | { kind: 'python' }
  | { kind: 'docker'; image: string; workingDirectory?: string }
  | {
      kind: 'singularity' | 'apptainer';
      artifactId: string;
      sha256: string;
      workingDirectory?: string;
    };
