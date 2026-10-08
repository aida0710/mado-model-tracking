import type { Artifact, CodeVersion, ComputeTarget } from '@mmt/contracts';
import type { ExecutionCatalog } from '../../src/types/executionCatalog';

const createdAt = '2026-10-08T00:00:00Z';
export const dockerCodeVersion: CodeVersion = {
  id: 'code-v1',
  codeId: 'code',
  projectId: 'project',
  version: 'v1',
  runtime: { kind: 'docker', image: `registry.example.com/team/infer@sha256:${'a'.repeat(64)}` },
  source: null,
  entrypoint: ['python', '/app/infer.py'],
  requirements: [],
  environment: {},
  supportedModelFamilies: ['Qwen3'],
  taskTypes: ['inference', 'evaluation'],
  createdAt,
};
export const computeTarget: ComputeTarget = {
  id: 'target',
  name: 'Container worker',
  host: 'worker.invalid',
  port: 22,
  username: 'worker',
  sshKeyPath: '/test/key',
  knownHostsPath: '/test/known_hosts',
  workDirectory: '/test/work',
  pythonExecutable: 'python3',
  runtimeKinds: ['python', 'docker'],
  gpuIds: ['0', '1'],
  maxConcurrentJobs: 1,
  enabled: true,
  executor: 'ssh',
};
export const sifArtifact: Artifact = {
  id: 'artifact',
  projectId: 'project',
  runId: null,
  path: 'images/infer.sif',
  backend: 'filesystem',
  storageKey: 'test-artifact',
  mimeType: 'application/octet-stream',
  size: 1024,
  sha256: 'b'.repeat(64),
  createdAt,
};
export const executionCatalog: ExecutionCatalog = {
  experiments: [
    {
      id: 'experiment',
      projectId: 'project',
      name: 'Evaluation',
      description: '',
      runCount: 0,
      createdAt,
    },
  ],
  models: [
    {
      id: 'model',
      projectId: 'project',
      name: 'Qwen test',
      family: 'Qwen3',
      description: '',
      latestVersion: 'v1',
      aliases: {},
      createdAt,
    },
  ],
  codes: [
    {
      id: 'code',
      projectId: 'project',
      name: 'Inference code',
      description: '',
      latestVersion: 'v1',
      createdAt,
    },
  ],
  datasets: [],
  runs: [],
  modelVersions: [],
  codeVersions: [dockerCodeVersion],
  datasetVersions: [
    {
      id: 'dataset-v1',
      datasetId: 'dataset',
      projectId: 'project',
      name: 'samples',
      namespace: 'test',
      version: 'v1',
      uri: 'artifact://dataset-artifact',
      digest: 'test-digest',
      schema: {},
      metadata: {},
      sourceRunId: null,
      parentDatasetVersionIds: [],
      externalRef: null,
      createdAt,
    },
  ],
};
