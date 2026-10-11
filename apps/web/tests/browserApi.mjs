// Isolated browser-test API. This module is never imported by production code.
import { createHash } from 'node:crypto';
import { listProjectArtifacts, listRunArtifacts, runArtifactTree } from './artifactListingMock.mjs';
import { createProjectAdministration } from './projectAdministrationMock.mjs';
// The API default of MMT_ARTIFACT_DELETE_GRACE_DAYS (apps/api/src/config.ts).
const DEFAULT_ARTIFACT_DELETE_GRACE_DAYS = 7;
// TokenSummary.tokenPrefix: the first characters of the token value.
const TOKEN_PREFIX_LENGTH = 12;
// Lists the Compute and Settings screens read when they open; the mock has none of these.
const EMPTY_PROJECT_LISTS = [
  'workers',
  'group-bindings',
  'service-accounts',
  'notification-channels',
  'notification-rules',
  'notification-deliveries',
];
// Whose Jobs a computer takes, as the API decides (targetUsableSql): everyone's on a public one,
// its owner's on a private one. The mock has no Service Accounts.
function isTargetUsable(target, user) {
  return target.visibility === 'public' || target.ownerUserId === user.id;
}

function isTargetManager(target, user) {
  return user.isAdmin || target.ownerUserId === user.id;
}

// GET /targets/overview: a row for every computer, with nothing of how it is reached.
function targetOverview(target, state) {
  const launcher =
    target.executor === 'site' && target.submissionMode === 'automatic' && target.site?.launcherId
      ? state.launchers.find((item) => item.id === target.site.launcherId)
      : undefined;
  return {
    id: target.id,
    name: target.name,
    executor: target.executor,
    submissionMode: target.submissionMode,
    cpuArch: target.cpuArch,
    supportsArray: target.supportsArray,
    enabled: target.enabled,
    visibility: target.visibility,
    ownerUserId: target.ownerUserId,
    ownerName: target.ownerName,
    usable: isTargetUsable(target, state.user),
    canManage: isTargetManager(target, state.user),
    launcher: launcher
      ? { name: launcher.name, lastSeenAt: launcher.lastSeenAt, revoked: launcher.revokedAt !== null }
      : null,
  };
}

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
    // Projects that existed before visibility stay private (migration 054).
    visibility: 'private',
    role: 'admin',
    createdAt: now,
  };
  const projectAdministration = createProjectAdministration({ id, now, user, mainProject: project });
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
    archivedAt: null,
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
    // The API defaults of migration 047.
    datasetCacheMaxBytes: 107374182400,
    datasetTransfer: 'relay',
    // The API defaults of migration 051 (sites).
    submissionMode: 'automatic',
    cpuArch: 'amd64',
    supportsArray: false,
    queueTimeoutSeconds: null,
    // Migration 057: a target from before owners is public, and GET /targets lists it to everyone.
    ownerUserId: null,
    ownerName: null,
    visibility: 'public',
    site: null,
    siteAccountMode: null,
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
    // Every Project with its archive state, and the bodies POST /projects received.
    projectAdministration: projectAdministration.state,
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
    launchers: [],
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
    const projectAnswer = projectAdministration.handle({
      path,
      method,
      url,
      body,
      reply,
      list,
      fulfillEmpty: () => route.fulfill({ status: 204, body: '' }),
    });
    if (projectAnswer) return projectAnswer;
    if (path === '/targets/overview' && method === 'GET')
      return list(state.targets.map((target) => targetOverview(target, state)));
    if (path === '/targets') {
      // With projectId, the screens that create Jobs: only what the user may run on.
      if (method === 'GET')
        return list(
          state.targets.filter(
            (target) =>
              isTargetUsable(target, user) ||
              (!url.searchParams.has('projectId') && isTargetManager(target, user)),
          ),
        );
      // The first job shell is not part of the target; whoever adds it owns it.
      const { jobShell: _jobShell, site, ...fields } = body;
      const target = {
        id: id(),
        ...fields,
        visibility: fields.visibility ?? 'private',
        ownerUserId: user.id,
        ownerName: user.displayName,
        site: site ? { ...site, jobShell: null } : null,
        siteAccountMode: site ? (site.accountMode ?? 'personal') : null,
      };
      state.targets.push(target);
      return reply(target, 201);
    }
    if (path === '/launchers' && method === 'GET') return list(state.launchers);
    // 全体設定 → アカウント (/settings/account), where the user menu and redirects land.
    if (path === '/account' && method === 'GET')
      return reply({
        user: { ...user, lastLoginAt: now, createdAt: now },
        groups: [],
        groupsSyncedAt: null,
        sessionAuthMethod: 'local',
      });
    if (path === '/tokens') {
      if (method === 'GET') return list(state.tokens);
      // TokenSummary of a token the signed-in user issues for themselves.
      const value = 'browser-test-value-only';
      const token = {
        id: id(),
        ...body,
        projectId: body.projectId ?? null,
        lastUsedAt: null,
        expiresAt: body.expiresAt ?? null,
        createdAt: now,
        ownerType: 'user',
        ownerId: user.id,
        ownerName: user.displayName,
        tokenPrefix: value.slice(0, TOKEN_PREFIX_LENGTH),
        legacy: false,
      };
      state.tokens.push(token);
      return reply({ token: value, item: token });
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
    if (EMPTY_PROJECT_LISTS.includes(resource) && !key && method === 'GET') return list([]);
    // The Settings screen's usage per storage backend; the mock reports none.
    if (resource === 'artifact-usage' && method === 'GET')
      return reply({ backends: [], deleteGraceDays: DEFAULT_ARTIFACT_DELETE_GRACE_DAYS });
    // Every token limited to the Project, so one issued on Settings is listed here too.
    if (resource === 'tokens' && !key && method === 'GET')
      return list(state.tokens.filter((token) => token.projectId === project.id));
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
      const isRunList = (key === 'search' && method === 'POST') || (!key && method === 'GET');
      // The Runs screen lists through the native search; both ways of listing fail together.
      if (state.failRunList && isRunList)
        return reply({ error: 'UI verification: database unavailable' }, 503);
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
      if (!key && method === 'GET')
        return list(
          state.runs.filter(
            (run) =>
              (!url.searchParams.get('status') || run.status === url.searchParams.get('status')) &&
              (!url.searchParams.get('experimentId') ||
                run.experimentId === url.searchParams.get('experimentId')),
          ),
        );
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
    // The upload dialog lists the user's open sessions to offer a resume. The mock keeps none: its
    // files are below SINGLE_PUT_MAX_BYTES (src/lib/uploadPlan.ts) and go through the PUT below.
    if (resource === 'artifact-uploads' && !key && method === 'GET') return list([]);
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
      // The alias history of a Model; the mock records no events.
      if (subresource === 'alias-events' && method === 'GET')
        return reply({ items: [], nextCursor: null });
    }
    if (resource === 'jobs') {
      // GET returns JobListItem: the Job with its Run and Task names (see api-contract.md).
      if (!key && method === 'GET')
        return list(
          state.jobs.map((job) => {
            const run = state.runs.find((candidate) => candidate.id === job.runId);
            return {
              ...job,
              runName: run?.name ?? job.runId,
              runKind: run?.kind ?? 'training',
              taskId: run?.taskId ?? null,
              taskName: null,
              sweepEarlyStopped: false,
            };
          }),
        );
      if (!key && method === 'POST') {
        if (state.failNextJob) {
          state.failNextJob = false;
          return reply({ error: 'UI verification: enqueue failed' }, 503);
        }
        const job = {
          id: id(),
          projectId: project.id,
          // The Job fields of sites, arrays, hooks and drivers that an ssh Job leaves at their defaults.
          phase: null,
          gpuCount: body.gpuIds?.length ?? 0,
          walltimeSeconds: null,
          schedulerJobId: null,
          submittedAt: null,
          runnerHost: null,
          arrayGroupId: null,
          arrayIndex: null,
          arraySize: null,
          endReason: null,
          parentJobId: null,
          chainDepth: 0,
          hookId: null,
          allowChildJobs: false,
          retryOnFailure: false,
          retryOnTimeout: false,
          datasetPartitionVersionId: null,
          siteJobShellId: null,
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
