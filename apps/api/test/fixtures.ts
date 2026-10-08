import type {
  Code,
  CodeVersion,
  ComputeTarget,
  Experiment,
  Model,
  ModelVersion,
  Project,
  Run,
  RunKind,
} from '@mmt/contracts';
import { entity, login, request, type Harness } from './harness.js';

export async function projectFixture(harness: Harness) {
  const administrator = await login(harness);
  const editor = await login(harness, 'editor@localhost');
  const viewer = await login(harness, 'viewer@localhost');
  const outsider = await login(harness, 'outsider@localhost');
  const project = await entity<Project>(
    await request(harness.app, '/api/projects', {
      method: 'POST',
      cookie: administrator.cookie,
      body: { name: 'Test Project' },
    }),
  );
  for (const [identity, role] of [
    [editor, 'editor'],
    [viewer, 'viewer'],
  ] as const) {
    await entity(
      await request(harness.app, `/api/projects/${project.id}/members/${identity.userId}`, {
        method: 'PUT',
        cookie: administrator.cookie,
        body: { role },
      }),
      200,
    );
  }
  const experiment = await entity<Experiment>(
    await request(harness.app, `/api/projects/${project.id}/experiments`, {
      method: 'POST',
      cookie: editor.cookie,
      body: { name: 'Test Experiment' },
    }),
  );
  const basePath = `/api/projects/${project.id}`;
  return { administrator, editor, viewer, outsider, project, experiment, basePath };
}

export async function executionFixture(harness: Harness) {
  const fixture = await projectFixture(harness);
  const { administrator, editor, project, experiment, basePath } = fixture;
  const code = await entity<Code>(
    await request(harness.app, `${basePath}/codes`, {
      method: 'POST',
      cookie: editor.cookie,
      body: { name: 'CPU Test Code' },
    }),
  );
  const codeVersion = await entity<CodeVersion>(
    await request(harness.app, `${basePath}/codes/${code.id}/versions`, {
      method: 'POST',
      cookie: editor.cookie,
      body: {
        version: 'v1',
        source: { kind: 'inline', files: { 'main.py': 'print("CPU test execution")\n' } },
        entrypoint: ['python', 'main.py'],
        supportedModelFamilies: ['qwen2'],
        taskTypes: ['inference', 'training', 'finetuning'],
      },
    }),
  );
  const model = await entity<Model>(
    await request(harness.app, `${basePath}/models`, {
      method: 'POST',
      cookie: editor.cookie,
      body: { name: 'Qwen2 Test', family: 'qwen2' },
    }),
  );
  const modelVersion = await entity<ModelVersion>(
    await request(harness.app, `${basePath}/models/${model.id}/versions`, {
      method: 'POST',
      cookie: editor.cookie,
      body: { version: 'base', defaultCodeVersionId: codeVersion.id },
    }),
  );
  const target = await entity<ComputeTarget>(
    await request(harness.app, '/api/targets', {
      method: 'POST',
      cookie: administrator.cookie,
      body: {
        name: 'Local test target',
        host: '127.0.0.1',
        port: 22,
        username: 'local',
        sshKeyPath: '',
        knownHostsPath: '',
        workDirectory: '/tmp/mmt-test-worker',
        pythonExecutable: 'python3',
        gpuIds: ['0', '1'],
        maxConcurrentJobs: 2,
        enabled: true,
        executor: 'local',
      },
    }),
  );
  const minted = await entity<{ token: string }>(
    await request(harness.app, '/api/tokens', {
      method: 'POST',
      cookie: administrator.cookie,
      body: {
        name: 'Test Worker',
        kind: 'service',
        projectId: project.id,
        scopes: ['worker:execute'],
      },
    }),
  );
  async function newRun(name = 'Inference', kind: RunKind = 'inference'): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${basePath}/runs`, {
        method: 'POST',
        cookie: editor.cookie,
        body: {
          experimentId: experiment.id,
          name,
          kind,
          modelVersionId: modelVersion.id,
        },
      }),
    );
  }
  return {
    ...fixture,
    code,
    codeVersion,
    model,
    modelVersion,
    target,
    workerToken: minted.token,
    newRun,
  };
}
