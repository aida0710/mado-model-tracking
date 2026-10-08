import type { Artifact, CodeVersion, ExecutionRuntime, ExecutionRuntimeKind } from '@mmt/contracts';
import { executionFixture } from './fixtures.js';
import { entity, request, type Harness } from './harness.js';

export const TEST_DOCKER_IMAGE = `registry.example.test/mmt/inference@sha256:${'a'.repeat(64)}`;

export function containerCodeInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 'container-v1',
    source: null,
    runtime: { kind: 'docker', image: TEST_DOCKER_IMAGE } as ExecutionRuntime,
    entrypoint: ['python', '/app/inference.py'],
    supportedModelFamilies: ['qwen2'],
    taskTypes: ['inference', 'evaluation'],
    ...overrides,
  };
}

export async function containerFixture(harness: Harness) {
  const fixture = await executionFixture(harness);
  const containerCodeVersion = await entity<CodeVersion>(
    await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: containerCodeInput(),
    }),
  );
  const runtimeKinds: ExecutionRuntimeKind[] = ['python', 'docker', 'singularity', 'apptainer'];
  await harness.database.query('UPDATE compute_targets SET runtime_kinds=$2 WHERE id=$1', [fixture.target.id, runtimeKinds]);
  return { ...fixture, target: { ...fixture.target, runtimeKinds }, containerCodeVersion };
}

export type ContainerFixture = Awaited<ReturnType<typeof containerFixture>>;

export async function uploadFixtureArtifact(
  harness: Harness,
  fixture: { basePath: string; editor: { cookie: string } },
  upload: { path: string; content?: string; runId?: string },
): Promise<Artifact> {
  const runPath = upload.runId ? `/runs/${upload.runId}` : '';
  return entity<Artifact>(
    await request(
      harness.app,
      `${fixture.basePath}${runPath}/artifacts?path=${encodeURIComponent(upload.path)}`,
      {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: upload.content ?? 'fixture artifact bytes',
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    ),
  );
}

export function automationRuleInput(
  fixture: ContainerFixture,
  overrides: Record<string, unknown> = {},
) {
  return {
    name: 'Automatic inference',
    modelFamilies: ['qwen2'],
    kind: 'inference',
    experimentId: fixture.experiment.id,
    codeVersionId: fixture.containerCodeVersion.id,
    targetId: fixture.target.id,
    ...overrides,
  };
}
