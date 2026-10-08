import type { CodeVersion, ExperimentTask } from '@mmt/contracts';
import { executionFixture } from './fixtures.js';
import { entity, request, type Harness } from './harness.js';

export async function workbenchFixture(harness: Harness) {
  const fixture = await executionFixture(harness);
  const codeVersion = await entity<CodeVersion>(
    await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        version: 'editable-v1',
        source: {
          kind: 'git',
          url: 'https://example.test/code.git',
          commit: 'a'.repeat(40),
          files: { 'main.py': 'print("overlay")', 'test.py': 'print("test")' },
          deletedFiles: ['old.py'],
        },
        entrypoint: ['python', 'main.py'],
        testEntrypoint: ['python', 'test.py'],
        environment: { PRIVATE_CODE_SETTING: 'fixture-only-setting' },
        requirements: ['pytest==8.0.0'],
        supportedModelFamilies: ['qwen2'],
        taskTypes: ['inference', 'training', 'finetuning'],
      },
    }),
  );
  const taskInput = {
    experimentId: fixture.experiment.id,
    name: 'Training task',
    kind: 'training',
    codeVersionId: codeVersion.id,
    modelVersionId: fixture.modelVersion.id,
    parameters: { epochs: 2, seed: 42 },
    tags: { task: 'fixture' },
    targetId: fixture.target.id,
    gpuIds: ['0'],
  };
  const task = await entity<ExperimentTask>(
    await request(harness.app, `${fixture.basePath}/tasks`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: taskInput,
    }),
  );
  return {
    ...fixture,
    savedCode: fixture.codeVersion,
    codeVersion,
    taskInput,
    task,
    taskPath: `${fixture.basePath}/tasks/${task.id}`,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
