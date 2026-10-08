// Isolated browser-test API. This module is never imported by production code.
import { createHash } from 'node:crypto';
import { listProjectArtifacts, listRunArtifacts, runArtifactTree } from './artifactListingMock.mjs';
export function createBrowserApi() {
  let sequence = 100;
  const id = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
  const now = '2026-10-08T00:00:00Z';
  const user = {
    id: id(),
    email: 'ui-test@example.invalid',
    displayName: 'UI検証担当',
    isAdmin: true,
    username: 'ui-test',
    status: 'active',
    authSources: ['local'],
  };
  const project = {
    id: id(),
    name: 'UI検証用プロジェクト',
    description: 'ブラウザテストのAPIデータ',
    artifactBackend: 'filesystem',
    role: 'admin',
    createdAt: now,
  };
  const experiment = {
    id: id(),
    projectId: project.id,
    name: 'UI検証用実験',
    description: '',
    runCount: 3,
    createdAt: now,
  };
  const model = {
    id: id(),
    projectId: project.id,
    name: 'UI検証モデル',
    family: 'test-family',
    description: '',
    latestVersion: 'v1',
    aliases: {},
    createdAt: now,
  };
  const code = {
    id: id(),
    projectId: project.id,
    name: 'UI検証コード',
    description: '',
    latestVersion: 'v1',
    createdAt: now,
  };
  const dataset = {
    id: id(),
    projectId: project.id,
    name: 'UI検証データ',
    namespace: 'test',
    description: '',
    latestVersion: 'v1',
    createdAt: now,
  };
  const codeVersion = {
    id: id(),
    codeId: code.id,
    projectId: project.id,
    version: 'v1',
    source: { kind: 'inline', files: { 'main.py': 'print("browser-test")' } },
    runtime: { kind: 'python' },
    entrypoint: ['python3', 'main.py'],
    requirements: [],
    environment: {},
    supportedModelFamilies: ['test-family'],
    taskTypes: ['inference', 'training', 'finetuning'],
    createdAt: now,
  };
  const modelVersion = {
    id: id(),
    modelId: model.id,
    projectId: project.id,
    version: 'v1',
    family: model.family,
    sourceRunId: null,
    parentModelVersionIds: [],
    weightsUri: 'file:///test/weights',
    artifactId: null,
    defaultCodeVersionId: codeVersion.id,
    metadata: {},
    createdAt: now,
  };
  const datasetVersion = {
    id: id(),
    datasetId: dataset.id,
    projectId: project.id,
    name: dataset.name,
    namespace: dataset.namespace,
    version: 'v1',
    uri: 'file:///test/data',
    digest: 'test-digest',
    schema: {},
    metadata: {},
    sourceRunId: null,
    parentDatasetVersionIds: [],
    externalRef: null,
    contentKind: 'reference',
    fileCount: null,
    totalSize: null,
    createdAt: now,
  };
  const makeRun = (body) => ({
    id: id(),
    projectId: project.id,
    experimentId: experiment.id,
    name: 'UI test',
    kind: 'inference',
    status: 'queued',
    parameters: {},
    tags: {},
    latestMetrics: {},
    modelVersionId: null,
    codeVersionId: null,
    inputDatasetVersionIds: [],
    outputDatasetVersionIds: [],
    outputModelVersionIds: [],
    parentRunId: null,
    environment: {},
    createdBy: user.id,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    error: null,
    ...body,
  });
  const runs = [
    makeRun({
      name: 'training-test-01',
      kind: 'training',
      status: 'finished',
      modelVersionId: modelVersion.id,
      codeVersionId: codeVersion.id,
      inputDatasetVersionIds: [datasetVersion.id],
      parameters: { lr: 0.001, batch_size: 32, spk_emb: true },
      latestMetrics: {
        'val/loss': 0.12,
        accuracy: 0.89,
        'train/loss': 0.123456789123,
        'val/cer': 0.0098123456,
      },
      startedAt: '2026-10-07T20:00:00Z',
      endedAt: now,
    }),
    makeRun({
      name: 'training-test-02',
      kind: 'training',
      status: 'finished',
      parameters: { lr: 0.0003, batch_size: 16, spk_emb: false },
      latestMetrics: { 'val/loss': 0.18, accuracy: 0.83 },
      startedAt: '2026-10-07T18:00:00Z',
      endedAt: now,
    }),
    makeRun({
      name: 'finetuning-test-03',
      kind: 'finetuning',
      status: 'running',
      parameters: { lr: 0.0001, batch_size: 32, spk_emb: true },
      latestMetrics: { 'val/loss': 0.15 },
      startedAt: now,
    }),
  ];
  const target = {
    id: id(),
    name: 'UI検証Compute',
    host: 'test.invalid',
    port: 22,
    username: 'test',
    sshKeyPath: '/test/key',
    knownHostsPath: '/test/known_hosts',
    workDirectory: '/test/work',
    pythonExecutable: 'python3',
    runtimeKinds: ['python'],
    gpuIds: ['0', '1'],
    maxConcurrentJobs: 1,
    enabled: true,
    executor: 'ssh',
  };
  const plugin = {
    id: id(),
    projectId: project.id,
    name: 'UI検証Plugin',
    baseUrl: 'http://test.invalid',
    tokenEnv: 'UI_TEST_PLUGIN_TOKEN',
    enabled: true,
    manifest: null,
    createdAt: now,
  };
  const manifest = {
    id: 'test-plugin',
    name: plugin.name,
    version: '1.0.0',
    protocolVersion: '1.0',
    capabilities: ['datasets.search', 'datasets.import', 'storage:metrics'],
  };
  const artifact = {
    id: id(),
    projectId: project.id,
    runId: runs[0].id,
    path: 'test.txt',
    backend: 'filesystem',
    storageKey: 'test',
    mimeType: 'text/plain',
    size: 21,
    sha256: createHash('sha256').update('Browser test artifact').digest('hex'),
    createdAt: now,
  };
  const state = {
    user,
    project,
    loggedIn: false,
    authMode: 'development',
    experiments: [experiment],
    models: [model],
    modelVersions: [modelVersion],
    codes: [code],
    codeVersions: [codeVersion],
    datasets: [dataset],
    datasetVersions: [datasetVersion],
    runs,
    targets: [target],
    jobs: [],
    automationRules: [],
    automationExecutions: [],
    plugins: [plugin],
    tokens: [],
    artifacts: [artifact],
    calls: [],
    failRunList: false,
    failNextJob: false,
    failNextAutomation: false,
    failNextAutomationToggle: false,
    failProjectArtifacts: false,
    failPluginMetrics: false,
    metricsGate: null,
    prometheus: `# HELP mado_storage_bucket_bytes Latest measured bucket size in bytes.
# TYPE mado_storage_bucket_bytes gauge
mado_storage_connection_info{connection_id="ui-c1",connection_name="UI検証ストレージ"} 1
mado_storage_capacity_tracking_enabled{connection_id="ui-c1"} 1
mado_storage_capacity_tracking_interval_seconds{connection_id="ui-c1"} 300
mado_storage_bucket_bytes{connection_id="ui-c1",bucket="audio"} 3221225472
mado_storage_bucket_objects{connection_id="ui-c1",bucket="audio"} 1200000
mado_storage_capacity_collection_age_seconds{connection_id="ui-c1",bucket="audio"} 65.5
mado_storage_capacity_collection_failures{connection_id="ui-c1",bucket="audio"} 0
mado_storage_prefix_bytes{connection_id="ui-c1",bucket="audio",prefix="speech/"} 1073741824
mado_storage_prefix_objects{connection_id="ui-c1",bucket="audio",prefix="speech/"} 400000
mado_storage_capacity_collection_failures{connection_id="ui-c1",bucket="unmeasured"} 2
`,
  };
  const item = (array, key) => array.find((value) => value.id === key);
  async function route(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    const body = request.headers()['content-type']?.includes('application/json')
      ? request.postDataJSON()
      : {};
    state.calls.push({ method, path, body });
    const reply = (payload, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    const list = (items) => reply({ items });
    if (path === '/auth/config')
      return reply({
        mode: state.authMode,
        methods: {
          local: state.authMode === 'local' || state.authMode === 'hybrid',
          oidc:
            state.authMode === 'oidc' || state.authMode === 'hybrid'
              ? { label: 'Authentik', loginUrl: '/api/auth/login' }
              : null,
        },
      });
    if (path === '/auth/login') {
      state.loggedIn = true;
      return route.fulfill({ status: 302, headers: { location: url.origin + '/' }, body: '' });
    }
    if (path === '/auth/me')
      return state.loggedIn
        ? reply({ user, mustChangePassword: false })
        : reply({ error: 'Unauthorized' }, 401);
    if (path === '/auth/dev-login') {
      state.loggedIn = true;
      return reply({ user, mustChangePassword: false });
    }
    if (path === '/auth/change-password' && method === 'POST')
      return route.fulfill({ status: 204, body: '' });
    if (path === '/auth/logout') {
      state.loggedIn = false;
      return reply({ ok: true });
    }
    if (!state.loggedIn) return reply({ error: 'Unauthorized' }, 401);
    if (path === '/storage/backends')
      return reply({ items: ['filesystem', 's3'], defaultBackend: 'filesystem' });
    if (path === '/projects' && method === 'GET') return list([project]);
    if (path === `/projects/${project.id}` && method === 'PATCH') {
      Object.assign(project, body);
      return reply(project);
    }
    if (path === '/targets') {
      if (method === 'GET') return list(state.targets);
      const target = { id: id(), ...body };
      state.targets.push(target);
      return reply(target);
    }
    if (path === '/tokens') {
      if (method === 'GET') return list(state.tokens);
      const token = {
        id: id(),
        ...body,
        lastUsedAt: null,
        expiresAt: body.expiresAt ?? null,
        createdAt: now,
      };
      state.tokens.push(token);
      return reply({ token: 'browser-test-value-only', item: token });
    }
    if (path.startsWith('/tokens/') && method === 'DELETE') {
      state.tokens = state.tokens.filter((token) => token.id !== path.split('/')[2]);
      return reply({ ok: true });
    }
    const parts = path.split('/').filter(Boolean).slice(2);
    const [resource, key, subresource] = parts;
    if (resource === 'automation-rules') {
      if (method === 'GET') return list(state.automationRules);
      if (!user.isAdmin && project.role !== 'admin') return reply({ error: 'Admin required' }, 403);
      if (method === 'POST') {
        if (state.failNextAutomation) {
          state.failNextAutomation = false;
          return reply({ error: 'UI verification: automation storage unavailable' }, 503);
        }
        const rule = {
          id: id(),
          projectId: project.id,
          createdBy: user.id,
          createdAt: now,
          ...body,
        };
        state.automationRules.unshift(rule);
        return reply(rule, 201);
      }
      if (method === 'PATCH') {
        if (Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean')
          return reply({ error: 'Only enabled can change' }, 400);
        if (state.failNextAutomationToggle) {
          state.failNextAutomationToggle = false;
          return reply({ error: 'UI verification: toggle failed' }, 503);
        }
        const rule = item(state.automationRules, key);
        rule.enabled = body.enabled;
        return reply(rule);
      }
    }
    if (resource === 'automation-executions' && method === 'GET')
      return list(state.automationExecutions);
    if (resource === 'audit-events' && method === 'GET') return reply({ items: [], nextCursor: null });
    // The promotion dialog reads these before an alias is set; the mock has none of them.
    if (resource === 'alias-protections' && method === 'GET') return list([]);
    if (resource === 'promotion-policies' && method === 'GET') return list([]);
    if (resource === 'promotion-evaluations' && method === 'GET')
      return reply({ items: [], nextCursor: null });
    if (resource === 'operations-alerts' && method === 'GET') return list([]);
    if (resource === 'members') {
      // ProjectMember: the mock grants the role directly and binds no SSO group.
      if (method === 'GET')
        return list([{ user, role: project.role, directRole: project.role, groups: [] }]);
      return reply({ user, role: body.role, directRole: body.role, groups: [] });
    }
    if (resource === 'lineage')
      return reply({
        nodes: [
          { id: datasetVersion.id, kind: 'datasetVersion', label: dataset.name },
          { id: runs[0].id, kind: 'run', label: runs[0].name },
          { id: modelVersion.id, kind: 'modelVersion', label: model.name },
          { id: codeVersion.id, kind: 'codeVersion', label: code.name },
        ],
        edges: [
          { source: datasetVersion.id, target: runs[0].id, relation: 'input' },
          { source: codeVersion.id, target: runs[0].id, relation: 'code' },
          { source: runs[0].id, target: modelVersion.id, relation: 'outputModel' },
        ],
      });
    if (resource === 'experiments') {
      if (method === 'GET') return list(state.experiments);
      const experiment = { id: id(), projectId: project.id, ...body, runCount: 0, createdAt: now };
      state.experiments.push(experiment);
      return reply(experiment);
    }
    if (resource === 'runs') {
      // Native search without filter parsing: enough for screens that list recent Runs.
      if (key === 'search' && method === 'POST')
        return reply({
          items: state.runs.filter(
            (run) =>
              (!body.experimentIds?.length || body.experimentIds.includes(run.experimentId)) &&
              (!body.statuses?.length || body.statuses.includes(run.status)) &&
              (!body.name || run.name.toLowerCase().includes(body.name.toLowerCase())),
          ),
          nextCursor: null,
        });
      if (!key && method === 'GET') {
        if (state.failRunList)
          return reply({ error: 'UI verification: database unavailable' }, 503);
        return list(
          state.runs.filter(
            (run) =>
              (!url.searchParams.get('status') || run.status === url.searchParams.get('status')) &&
              (!url.searchParams.get('experimentId') ||
                run.experimentId === url.searchParams.get('experimentId')),
          ),
        );
      }
      if (!key && method === 'POST') {
        const run = makeRun(body);
        state.runs.push(run);
        return reply(run);
      }
      const run = item(state.runs, key);
      if (!subresource) {
        if (method === 'PATCH') Object.assign(run, body);
        return reply(run);
      }
      if (subresource === 'metrics')
        return list([
          { name: 'val/loss', value: 0.9, step: 0, timestamp: now },
          {
            name: 'val/loss',
            value: run.latestMetrics['val/loss'] ?? 0.12,
            step: 100,
            timestamp: now,
          },
          { name: 'system/gpu.utilization', value: 64, step: 100, timestamp: now },
        ]);
      if (subresource === 'logs')
        return list([{ timestamp: now, level: 'info', message: 'Browser test log' }]);
      if (subresource === 'artifacts' && parts[3] === 'tree')
        return reply(runArtifactTree(state.artifacts, key, url.searchParams));
      if (subresource === 'artifacts') {
        if (method === 'GET') return reply(listRunArtifacts(state.artifacts, key, url.searchParams));
        const artifact = {
          id: id(),
          projectId: project.id,
          runId: key,
          path: url.searchParams.get('path'),
          backend: 'filesystem',
          storageKey: 'test',
          mimeType: request.headers()['content-type'],
          size: request.postDataBuffer()?.length ?? 0,
          sha256: createHash('sha256')
            .update(request.postDataBuffer() ?? Buffer.alloc(0))
            .digest('hex'),
          createdAt: now,
        };
        state.artifacts.push(artifact);
        return reply(artifact);
      }
    }
    if (resource === 'artifacts' && !key && method === 'GET') {
      if (state.failProjectArtifacts)
        return reply({ error: 'UI verification: artifact catalog unavailable' }, 503);
      return reply(listProjectArtifacts(state.artifacts, url.searchParams));
    }
    if (resource === 'artifacts' && method === 'PUT') {
      const created = {
        ...artifact,
        id: id(),
        runId: null,
        path: url.searchParams.get('path'),
        mimeType: request.headers()['content-type'],
        size: request.postDataBuffer()?.length ?? 0,
        sha256: createHash('sha256')
          .update(request.postDataBuffer() ?? Buffer.alloc(0))
          .digest('hex'),
      };
      state.artifacts.push(created);
      return reply(created);
    }
    if (resource === 'artifacts' && key && !subresource && method === 'GET')
      return reply(item(state.artifacts, key));
    if (resource === 'artifacts' && subresource === 'content')
      return route.fulfill({ contentType: 'text/plain', body: 'Browser test artifact' });
    if (['models', 'codes', 'datasets'].includes(resource)) {
      const collection = state[resource];
      const versionCollection =
        state[
          { models: 'modelVersions', codes: 'codeVersions', datasets: 'datasetVersions' }[resource]
        ];
      const parentKey = { models: 'modelId', codes: 'codeId', datasets: 'datasetId' }[resource];
      if (!key && method === 'GET') return list(collection);
      if (!key && method === 'POST') {
        const entity = {
          id: id(),
          projectId: project.id,
          latestVersion: null,
          aliases: {},
          namespace: '',
          description: '',
          ...body,
          createdAt: now,
        };
        collection.push(entity);
        return reply(entity);
      }
      if (subresource === 'versions' && method === 'GET')
        return list(versionCollection.filter((version) => version[parentKey] === key));
      if (subresource === 'versions' && method === 'POST') {
        const parent = item(collection, key);
        parent.latestVersion = body.version;
        const version = {
          id: id(),
          projectId: project.id,
          [parentKey]: key,
          sourceRunId: null,
          parentModelVersionIds: [],
          parentDatasetVersionIds: [],
          defaultCodeVersionId: null,
          artifactId: null,
          weightsUri: null,
          schema: {},
          metadata: {},
          externalRef: null,
          family: parent.family,
          name: parent.name,
          namespace: parent.namespace,
          ...body,
          createdAt: now,
        };
        versionCollection.push(version);
        return reply(version);
      }
      if (subresource === 'aliases') {
        item(collection, key).aliases[parts[3]] = body.versionId;
        return reply(item(collection, key));
      }
    }
    if (resource === 'jobs') {
      if (!key && method === 'GET') return list(state.jobs);
      if (!key && method === 'POST') {
        if (state.failNextJob) {
          state.failNextJob = false;
          return reply({ error: 'UI verification: enqueue failed' }, 503);
        }
        const job = {
          id: id(),
          projectId: project.id,
          ...body,
          status: 'queued',
          cancelRequested: false,
          attempt: 0,
          createdAt: now,
          startedAt: null,
          endedAt: null,
          heartbeatAt: null,
          error: null,
          exitCode: null,
        };
        state.jobs.push(job);
        return reply(job);
      }
      if (subresource === 'cancel') {
        const job = item(state.jobs, key);
        job.cancelRequested = true;
        return reply(job);
      }
      if (subresource === 'retry') {
        const oldJob = item(state.jobs, key);
        const run = makeRun({ ...item(state.runs, oldJob.runId), id: id(), status: 'queued' });
        state.runs.push(run);
        const job = { ...oldJob, id: id(), runId: run.id, status: 'queued' };
        state.jobs.push(job);
        return reply({ run, job });
      }
    }
    if (resource === 'plugins') {
      if (project.role !== 'admin') return reply({ error: 'Project admin required' }, 403);
      if (!key && method === 'GET') return list(state.plugins);
      if (!key && method === 'POST') {
        if (!user.isAdmin) return reply({ error: 'Global admin required' }, 403);
        const plugin = { id: id(), projectId: project.id, manifest: null, ...body, createdAt: now };
        state.plugins.push(plugin);
        return reply(plugin);
      }
      if (subresource === 'check') {
        item(state.plugins, key).manifest = manifest;
        return reply(manifest);
      }
      if (subresource === 'metrics') {
        if (!item(state.plugins, key).manifest?.capabilities.includes('storage:metrics'))
          return reply({ error: 'Unsupported capability' }, 422);
        if (state.metricsGate) await state.metricsGate;
        if (state.failPluginMetrics)
          return reply({ error: 'UI verification: metrics unavailable' }, 502);
        return reply({ prometheus: state.prometheus });
      }
      if (subresource === 'events') return reply({ queued: 2 });
      if (subresource === 'outbox')
        return reply({
          pending: 0,
          sending: 0,
          oldestPendingAt: null,
          maxAttempts: 0,
          lastError: null,
          lastDeliveredAt: null,
          stalled: false,
        });
      if (subresource === 'datasets' && parts[3] === 'search')
        return list([
          {
            externalId: 'browser-test-external',
            namespace: 'test',
            name: 'UI検索データ',
            version: 'v1',
            uri: 'file:///test/import',
            digest: 'import-digest',
            schema: {},
            metadata: {},
          },
        ]);
      if (subresource === 'datasets' && parts[3] === 'import') {
        const imported = { ...datasetVersion, id: id(), ...body.dataset };
        state.datasetVersions.push(imported);
        return reply(imported);
      }
    }
    return reply({ error: `Unhandled test API: ${method} ${path}` }, 501);
  }
  return { state, route };
}
