/** Connect the real host/outbox and separate plugin to Mado's HTTP routes with an isolated Registry fixture. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createApplication } from '../apps/api/src/app.js';
import { createHarness, entity, login, request } from '../apps/api/test/harness.js';
import type {
  Dataset,
  DatasetVersion,
  Experiment,
  PluginConnection,
  PluginDataset,
  Project,
  Run,
} from '@mmt/contracts';

const madoRoot = process.env.MMT_VERIFY_MADO_ROOT ?? path.resolve('../mado-api-model-tracking');
const pluginRoot =
  process.env.MMT_VERIFY_PLUGIN_ROOT ?? path.resolve('../mado-model-tracking-plugin-mado');
const { mountServiceLineageRoutes } = await import(
  pathToFileURL(path.join(madoRoot, 'api/routes/service-lineage.ts')).href
);
const { mountOpenLineageRoutes } = await import(
  pathToFileURL(path.join(madoRoot, 'api/routes/openlineage.ts')).href
);
const { mountMetricsRoutes } = await import(
  pathToFileURL(path.join(madoRoot, 'api/routes/metrics.ts')).href
);
const { createPluginApp } = await import(pathToFileURL(path.join(pluginRoot, 'src/app.ts')).href);

async function listen(app: Hono) {
  let server: ReturnType<typeof serve>;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (address) =>
      resolve(address.port),
    );
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const datasetId = randomUUID(),
  versionId = randomUUID();
const version = {
  id: versionId,
  datasetId,
  version: 'v1',
  contentHash: 'sha256:fixture',
  manifestUri: null,
  manifestHash: null,
  schemaUri: null,
  createdAt: new Date().toISOString(),
  metadata: { secret: 'private-fixture' },
  locations: [
    {
      id: randomUUID(),
      uri: 's3://fixtures/corpus/v1',
      status: 'available',
      storageKind: 's3',
      isPrimary: true,
    },
  ],
};
const dataset = {
  datasetId,
  namespace: 'speech',
  name: 'fixture-corpus',
  displayName: 'Fixture Corpus',
  description: '',
  mediaType: 'audio',
  currentVersionId: versionId,
  versionCount: 1,
  createdAt: version.createdAt,
  versions: [version],
};
const readToken = randomBytes(24).toString('hex'),
  writeToken = randomBytes(24).toString('hex'),
  metricsToken = randomBytes(24).toString('hex'),
  pluginToken = randomBytes(24).toString('hex');
const events: Array<{
  eventType: string;
  inputs: Array<{ name: string; namespace: string; facets: unknown }>;
  outputs: Array<{ name: string; namespace: string; facets: unknown }>;
}> = [];
const registry = {
  searchDatasets: async () => ({ results: [dataset], totalCount: 1 }),
  getDataset: async () => dataset,
  getVersion: async () => version,
  ingestOpenLineage: async (event: (typeof events)[number]) => {
    events.push(event);
    return { accepted: true, duplicate: false };
  },
};
const mado = new Hono(),
  madoPrivate = new Hono();
mountServiceLineageRoutes(madoPrivate, {
  registry,
  authenticate: async (token: string) =>
    token === readToken ? { scopes: ['lineage:read'], namespaces: ['speech'] } : null,
});
mountMetricsRoutes(madoPrivate, {
  authenticate: async (token: string) =>
    token === metricsToken ? { scopes: ['metrics:read'] } : null,
  collectors: [
    {
      name: 'capacity',
      collect: async () => [
        {
          name: 'mado_storage_bucket_bytes',
          help: 'Fixture bytes',
          type: 'gauge',
          samples: [
            {
              labels: { connection_id: 'fixture', bucket: 'corpus' },
              value: '1048576',
            },
          ],
        },
      ],
    },
  ],
});
mado.route('/api/mado', madoPrivate);
const lineage = new Hono();
mountOpenLineageRoutes(lineage, {
  registry,
  auth: {
    authenticate: async (token: string) =>
      token === writeToken
        ? {
            serviceAccountId: randomUUID(),
            keyId: randomUUID(),
            scopes: ['lineage:write'],
            namespaces: ['mado-model-tracking', 'local'],
          }
        : null,
  },
});
mado.route('/api', lineage);
const madoServer = await listen(mado);
const ledgerDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-plugin-ledger-'));
const pluginServer = await listen(
  createPluginApp({
    pluginToken,
    madoBaseUrl: madoServer.url,
    madoLineageUrl: madoServer.url,
    readToken,
    lineageToken: writeToken,
    metricsToken,
    namespaces: ['speech'],
    jobNamespace: 'mado-model-tracking',
    storageSystemKey: 'mado-model-tracking',
    ledgerDirectory,
  }),
);
const harness = await createHarness();
const host = createApplication({
  config: harness.config,
  database: harness.database,
  stores: harness.stores,
  environment: { MMT_VERIFY_PLUGIN_TOKEN: pluginToken },
});
try {
  const administrator = await login(harness);
  const project = await entity<Project>(
    await request(host.app, '/api/projects', {
      method: 'POST',
      cookie: administrator.cookie,
      body: { name: 'Mado integration fixture' },
    }),
  );
  const basePath = `/api/projects/${project.id}`;
  const plugin = await entity<PluginConnection>(
    await request(host.app, `${basePath}/plugins`, {
      method: 'POST',
      cookie: administrator.cookie,
      body: {
        name: 'Mado',
        baseUrl: pluginServer.url,
        tokenEnv: 'MMT_VERIFY_PLUGIN_TOKEN',
      },
    }),
  );
  const manifest = await entity<{ capabilities: string[] }>(
    await request(host.app, `${basePath}/plugins/${plugin.id}/check`, {
      method: 'POST',
      cookie: administrator.cookie,
    }),
    200,
  );
  assert(manifest.capabilities.includes('storage:metrics'));
  const metrics = await entity<{ prometheus: string }>(
    await request(host.app, `${basePath}/plugins/${plugin.id}/metrics`, {
      cookie: administrator.cookie,
    }),
    200,
  );
  assert(metrics.prometheus.includes('mado_storage_bucket_bytes'));
  assert(metrics.prometheus.includes('1048576'));
  const found = await entity<{ items: PluginDataset[] }>(
    await request(host.app, `${basePath}/plugins/${plugin.id}/datasets/search`, {
      method: 'POST',
      cookie: administrator.cookie,
      body: { query: 'corpus' },
    }),
    200,
  );
  assert.equal(found.items[0]?.externalId, versionId);
  assert(!JSON.stringify(found).includes('private-fixture'));
  const imported = await entity<DatasetVersion>(
    await request(host.app, `${basePath}/plugins/${plugin.id}/datasets/import`, {
      method: 'POST',
      cookie: administrator.cookie,
      body: { dataset: found.items[0] },
    }),
  );
  assert.equal(imported.externalRef?.externalId, versionId);
  const experiment = await entity<Experiment>(
    await request(host.app, `${basePath}/experiments`, {
      method: 'POST',
      cookie: administrator.cookie,
      body: { name: 'Plugin flow' },
    }),
  );
  const run = await entity<Run>(
    await request(host.app, `${basePath}/runs`, {
      method: 'POST',
      cookie: administrator.cookie,
      body: {
        experimentId: experiment.id,
        name: 'Mado dataset processing',
        kind: 'processing',
        inputDatasetVersionIds: [imported.id],
      },
    }),
  );
  for (const status of ['running', 'finished'])
    await entity(
      await request(host.app, `${basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: administrator.cookie,
        body: { status },
      }),
      200,
    );
  assert.equal(await host.outbox.dispatchBatch(), 2);
  assert.deepEqual(
    events.map((event) => event.eventType),
    ['START', 'COMPLETE'],
  );
  assert.equal(events[1]?.inputs[0]?.namespace, 'speech');
  assert.equal(events[1]?.inputs[0]?.name, 'fixture-corpus');
  const outputDataset = await entity<Dataset>(
    await request(host.app, `${basePath}/datasets`, {
      method: 'POST',
      cookie: administrator.cookie,
      body: { name: 'predictions', namespace: 'local' },
    }),
  );
  await entity<DatasetVersion>(
    await request(host.app, `${basePath}/datasets/${outputDataset.id}/versions`, {
      method: 'POST',
      cookie: administrator.cookie,
      body: {
        version: 'v1',
        uri: 's3://fixtures/predictions/v1',
        digest: 'sha256:fixture-output',
        sourceRunId: run.id,
      },
    }),
  );
  assert.equal(await host.outbox.dispatchBatch(), 1);
  assert.equal(events[2]?.eventType, 'COMPLETE');
  assert.equal(events[2]?.outputs[0]?.namespace, 'mado-model-tracking');
  assert.equal(events[2]?.outputs[0]?.name, `${project.id}/local/predictions`);
  assert.equal(events[2]?.inputs[0]?.namespace, 'speech');
  const stored = await harness.database.query('SELECT status FROM plugin_outbox');
  assert(stored.rows.every((row) => row.status === 'delivered'));
  const summary = {
    checks: [
      'Mado namespace-scoped catalog and immutable version read',
      'separate plugin search and host import',
      'Mado metrics:read through authenticated plugin and host API',
      'host Run transaction and durable outbox',
      'real Mado OpenLineage profile/scope validation',
      'START/COMPLETE delivered with original input identity',
      'late output registration refreshes COMPLETE with a Project-scoped dataset identity',
    ],
    registry: 'isolated fixture; production Registry was not contacted',
  };
  const verificationDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const artifactDirectory = path.resolve(`artifacts/verification/${verificationDate}`);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    path.join(artifactDirectory, 'mado-plugin-integration.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await host.outbox.stop();
  await harness.close();
  await pluginServer.close();
  await madoServer.close();
  await rm(ledgerDirectory, { recursive: true, force: true });
}
