import { Readable } from 'node:stream';
import type { CodeVersion, DatasetVersion, ModelVersion, Run } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { ApplicationOptions } from '../app.js';
import { createApplication } from '../app.js';
import { DomainError } from '../domain/errors.js';
import { first } from '../db/database.js';
import { upsertIdentity } from '../repositories/identityRepository.js';
import {
  codeVersionSchema,
  datasetVersionSchema,
  modelVersionSchema,
  runCreateSchema,
} from '../domain/validation.js';
import { createSampleWave, trainLinearSample } from './sampleComputation.js';
import {
  linearInferenceProgram,
  linearTrainingProgram,
  qwenInferenceProgram,
} from './samplePrograms.js';

const DEMO_PROJECT_NAME = 'Mado Model Tracking Demo';

export async function seedDemo(
  options: ApplicationOptions,
): Promise<{ projectId: string; alreadySeeded: boolean }> {
  if (!options.config.allowSeed)
    throw new DomainError(
      403,
      'Seedにはdevelopment modeとMMT_ALLOW_SEED=trueが必要です',
      'seed_disabled',
    );
  const { database, config } = options;
  const seedLock = await database.connect();
  try {
    await seedLock.query('SELECT pg_advisory_lock(4182,2)');
    const complete = await first<{ projectId: string }>(
      database,
      'SELECT project_id FROM demo_seed_history WHERE name=$1',
      [DEMO_PROJECT_NAME],
    );
    if (complete) return { projectId: complete.projectId, alreadySeeded: true };
    const incomplete = await first(database, 'SELECT id FROM projects WHERE name=$1', [
      DEMO_PROJECT_NAME,
    ]);
    if (incomplete)
      throw new DomainError(
        409,
        '同名のProjectまたは未完了のseedがあります。内容を確認してから再実行してください',
        'incomplete_seed',
      );
    const services = createApplication(options).services;
    const administrator = await upsertIdentity(database, {
      issuer: 'development',
      subject: config.developmentAdminEmail,
      email: config.developmentAdminEmail,
      displayName: '開発管理者',
      isAdmin: true,
    });
    const principal: Principal = { user: administrator, method: 'session', token: null };
    const project = await services.projects.create(principal, {
      name: DEMO_PROJECT_NAME,
      description: '明示許可で投入したデモ。CPU計算と生成音声は実データ、QwenのRunは未実行。',
      artifactBackend: 'filesystem',
    });
    for (const role of ['editor', 'viewer'] as const) {
      const email = `${role}@localhost`;
      const user = await upsertIdentity(database, {
        issuer: 'development',
        subject: email,
        email,
        displayName: role === 'editor' ? '開発編集者' : '開発閲覧者',
        isAdmin: false,
      });
      await services.projects.setMember(principal, project.id, { userId: user.id, role });
    }
    const experiment = await services.projects.createExperiment(principal, project.id, {
      name: 'CPU examples',
      description: '標準ライブラリで動く線形回帰と生成音声の例',
    });
    const codeVersions = new Map<string, CodeVersion>();
    const examples = [
      {
        name: 'CPU linear training',
        family: 'linear',
        kind: 'training',
        filename: 'train.py',
        program: linearTrainingProgram,
      },
      {
        name: 'CPU linear inference',
        family: 'linear',
        kind: 'inference',
        filename: 'infer.py',
        program: linearInferenceProgram,
      },
      {
        name: 'Qwen2 inference',
        family: 'qwen2',
        kind: 'inference',
        filename: 'infer.py',
        program: qwenInferenceProgram,
      },
      {
        name: 'Qwen3 inference',
        family: 'qwen3',
        kind: 'inference',
        filename: 'infer.py',
        program: qwenInferenceProgram,
      },
    ];
    for (const example of examples) {
      const code = await services.registry.createCode(principal, project.id, {
        name: example.name,
        description: '実行できるinline Python code',
      });
      const version = await services.registry.createCodeVersion(principal, project.id, {
        codeId: code.id,
        input: codeVersionSchema.parse({
          version: 'v1',
          source: { kind: 'inline', files: { [example.filename]: example.program } },
          entrypoint: ['python', example.filename],
          supportedModelFamilies: [example.family],
          taskTypes: example.kind === 'training' ? ['training', 'finetuning'] : [example.kind],
          requirements: example.family === 'linear' ? [] : ['torch', 'transformers'],
        }),
      });
      codeVersions.set(example.name, version);
    }
    const createRun = (input: Record<string, unknown>): Promise<Run> =>
      services.runs.create(
        principal,
        project.id,
        runCreateSchema.parse({ experimentId: experiment.id, ...input }),
      );
    const trainingRun = await createRun({
      name: 'CPU linear regression',
      kind: 'training',
      codeVersionId: codeVersions.get('CPU linear training')!.id,
      parameters: { steps: 60, learningRate: 0.2 },
      tags: { demo: 'true', execution: 'seed CPU calculation' },
      environment: { executor: 'local', implementation: 'TypeScript equivalent of bundled Python' },
    });
    await services.runs.patch(principal, project.id, {
      runId: trainingRun.id,
      input: { status: 'running' },
    });
    const computation = trainLinearSample();
    await services.runs.addMetrics(principal, project.id, {
      runId: trainingRun.id,
      metrics: computation.metrics,
    });
    const weights = await services.artifacts.upload(principal, project.id, {
      runId: trainingRun.id,
      path: 'weights.json',
      mimeType: 'application/json',
      body: Readable.from([Buffer.from(JSON.stringify(computation.weights))]),
    });
    const linearModel = await services.registry.createModel(principal, project.id, {
      name: 'CPU Linear Model',
      family: 'linear',
      description: 'y=2x+1を学習した実際の小さい線形モデル',
    });
    const linearVersion: ModelVersion = await services.registry.createModelVersion(
      principal,
      project.id,
      {
        modelId: linearModel.id,
        input: modelVersionSchema.parse({
          version: 'v1',
          sourceRunId: trainingRun.id,
          artifactId: weights.id,
          defaultCodeVersionId: codeVersions.get('CPU linear inference')!.id,
          metadata: computation.weights,
        }),
      },
    );
    await services.registry.setAlias(principal, project.id, {
      modelId: linearModel.id,
      alias: 'latest',
      versionId: linearVersion.id,
    });
    await services.runs.addLogs(principal, project.id, {
      runId: trainingRun.id,
      entries: [
        {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'SeedでCPU線形回帰を計算し、metricsとweights.jsonを保存しました。',
        },
      ],
    });
    await services.runs.patch(principal, project.id, {
      runId: trainingRun.id,
      input: { status: 'finished' },
    });
    await createRun({
      name: 'CPU inference ready',
      kind: 'inference',
      modelVersionId: linearVersion.id,
      parameters: { ...computation.weights, inputs: [0, 1, 2] },
      tags: { demo: 'true' },
    });
    for (const reference of [
      { name: 'Qwen2.5-0.5B', family: 'qwen2' },
      { name: 'Qwen3-0.6B', family: 'qwen3' },
    ]) {
      const model = await services.registry.createModel(principal, project.id, {
        ...reference,
        description: '公開モデルの参照。重みの取得・推論は未実行。',
      });
      const version = await services.registry.createModelVersion(principal, project.id, {
        modelId: model.id,
        input: modelVersionSchema.parse({
          version: 'base',
          weightsUri: `hf://Qwen/${reference.name}`,
          defaultCodeVersionId: codeVersions.get(
            reference.family === 'qwen2' ? 'Qwen2 inference' : 'Qwen3 inference',
          )!.id,
        }),
      });
      await services.registry.setAlias(principal, project.id, {
        modelId: model.id,
        alias: 'base',
        versionId: version.id,
      });
      await createRun({
        name: `${reference.name} inference ready`,
        kind: 'inference',
        modelVersionId: version.id,
        parameters: { prompt: 'Hello', maxNewTokens: 16 },
        tags: { demo: 'true', execution: 'not started' },
      });
    }
    const audioRun = await createRun({
      name: 'Generated audio sample',
      kind: 'processing',
      parameters: { frequency: 440, sampleRate: 16000, seconds: 1 },
      tags: { demo: 'true', audio: 'synthetic sine' },
    });
    await services.runs.patch(principal, project.id, {
      runId: audioRun.id,
      input: { status: 'running' },
    });
    const wave = await services.artifacts.upload(principal, project.id, {
      runId: audioRun.id,
      path: 'sample.wav',
      mimeType: 'audio/wav',
      body: Readable.from([createSampleWave()]),
    });
    const dataset = await services.registry.createDataset(principal, project.id, {
      name: 'Generated audio',
      namespace: 'demo',
      description: '実音声を含まない440Hzの生成サンプル',
    });
    const audioVersion: DatasetVersion = await services.registry.createDatasetVersion(
      principal,
      project.id,
      {
        datasetId: dataset.id,
        input: datasetVersionSchema.parse({
          version: 'v1',
          uri: `artifact://${wave.id}`,
          digest: `sha256:${wave.sha256}`,
          sourceRunId: audioRun.id,
          schema: { sampleRate: 16000, channels: 1 },
          metadata: { durationSeconds: 1, synthetic: true },
        }),
      },
    );
    await services.runs.addMetrics(principal, project.id, {
      runId: audioRun.id,
      metrics: [
        { name: 'duration_seconds', value: 1, step: 0, timestamp: new Date().toISOString() },
      ],
    });
    await services.runs.patch(principal, project.id, {
      runId: audioRun.id,
      input: { status: 'finished' },
    });
    await createRun({
      name: 'Audio evaluation ready',
      kind: 'evaluation',
      inputDatasetVersionIds: [audioVersion.id],
      tags: { demo: 'true' },
    });
    if (config.allowLocalExecutor) {
      const existingTarget = (await services.targets.list(principal)).find(
        (target) => target.name === 'Local CPU',
      );
      if (!existingTarget)
        await services.targets.create(principal, {
          name: 'Local CPU',
          executor: 'local',
          host: '127.0.0.1',
          port: 22,
          username: 'local',
          sshKeyPath: '',
          knownHostsPath: '',
          workDirectory: options.environment?.MMT_LOCAL_WORK_DIRECTORY ?? '/tmp/mmt-local-worker',
          pythonExecutable: 'python3',
          gpuIds: [],
          maxConcurrentJobs: 2,
          enabled: true,
        });
    }
    await database.query('INSERT INTO demo_seed_history(name,project_id) VALUES($1,$2)', [
      DEMO_PROJECT_NAME,
      project.id,
    ]);
    return { projectId: project.id, alreadySeeded: false };
  } finally {
    await seedLock.query('SELECT pg_advisory_unlock(4182,2)');
    seedLock.release();
  }
}
