import type {
  ArtifactUpload,
  ExperimentTask,
  Model,
  ModelAutomationRule,
  ModelVersion,
  Run,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildOpenApiDocument } from '../src/http/openapi/buildOpenApiDocument.js';
import { isNonJsonContent, type SuccessStatus } from '../src/http/openapi/nativeRoute.js';
import { NATIVE_ROUTES } from '../src/http/openapi/routeCatalog.js';
import { executionFixture } from './fixtures.js';
import { createHarness, request, testDatabaseUrl, type Harness } from './harness.js';
import { workbenchFixture } from './workbenchFixtures.js';

const UPLOAD_CONTENT = new TextEncoder().encode('openapi conformance\n');

/** The response schema the document publishes for a route template and status. */
function publishedSchema(method: string, path: string, status: SuccessStatus): z.ZodType {
  const route = NATIVE_ROUTES.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  const content = route?.responses[status];
  if (!content || isNonJsonContent(content))
    throw new Error(`${method} ${path} publishes no JSON body for HTTP ${status}`);
  return content;
}

/**
 * Asserts the status and that the body parses with the published (strict) schema, so a field
 * the API returns but the document lacks, or a type mismatch, fails here.
 */
async function conforms<T>(
  response: Response,
  route: { method: string; path: string; status: SuccessStatus },
): Promise<T> {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(route.status);
  const parsed = publishedSchema(route.method, route.path, route.status).safeParse(body);
  expect(parsed.success ? [] : parsed.error.issues, `${route.method} ${route.path}`).toEqual([]);
  return body as T;
}

describe.skipIf(!testDatabaseUrl)('OpenAPIの応答schemaと実応答（独立PostgreSQL）', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });
  afterAll(async () => harness?.close());
  beforeEach(async () => harness.reset());

  it('GET /api/openapi.jsonはlogin済みの利用者に生成した文書を返し、未認証は401', async () => {
    const fixture = await executionFixture(harness);
    expect((await request(harness.app, '/api/openapi.json')).status).toBe(401);
    const response = await request(harness.app, '/api/openapi.json', {
      cookie: fixture.viewer.cookie,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('Runの作成・取得・一覧・変更・検索の応答がRunのschemaに適合する', async () => {
    const fixture = await executionFixture(harness);
    const { basePath, editor, viewer } = fixture;
    const run = await conforms<Run>(
      await request(harness.app, `${basePath}/runs`, {
        method: 'POST',
        cookie: editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Conformance',
          kind: 'training',
          parameters: { learningRate: 0.01, layers: [2, 4], nested: { flag: true } },
          tags: { purpose: 'openapi' },
          modelVersionId: fixture.modelVersion.id,
        },
      }),
      { method: 'post', path: '/api/projects/:p/runs', status: 201 },
    );
    const recorded = await request(harness.app, `${basePath}/runs/${run.id}/metrics`, {
      method: 'POST',
      cookie: editor.cookie,
      body: {
        metrics: [{ name: 'loss', value: 0.5, step: 1, timestamp: new Date().toISOString() }],
      },
    });
    expect(recorded.status).toBe(204);
    await conforms(
      await request(harness.app, `${basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: editor.cookie,
        body: { status: 'finished' },
      }),
      { method: 'patch', path: '/api/projects/:p/runs/:r', status: 200 },
    );
    await conforms(
      await request(harness.app, `${basePath}/runs/${run.id}`, { cookie: viewer.cookie }),
      {
        method: 'get',
        path: '/api/projects/:p/runs/:r',
        status: 200,
      },
    );
    await conforms(await request(harness.app, `${basePath}/runs`, { cookie: viewer.cookie }), {
      method: 'get',
      path: '/api/projects/:p/runs',
      status: 200,
    });
    const page = await conforms<{ items: Run[] }>(
      await request(harness.app, `${basePath}/runs/search`, {
        method: 'POST',
        cookie: viewer.cookie,
        body: { filter: 'metrics.loss < 1' },
      }),
      { method: 'post', path: '/api/projects/:p/runs/search', status: 200 },
    );
    expect(page.items.map((item) => item.id)).toEqual([run.id]);
  });

  it('Model・版・aliasの応答がschemaに適合する', async () => {
    const fixture = await executionFixture(harness);
    const { basePath, editor, viewer } = fixture;
    const model = await conforms<Model>(
      await request(harness.app, `${basePath}/models`, {
        method: 'POST',
        cookie: editor.cookie,
        body: { name: 'Conformance Model', family: 'qwen2' },
      }),
      { method: 'post', path: '/api/projects/:p/models', status: 201 },
    );
    const version = await conforms<ModelVersion>(
      await request(harness.app, `${basePath}/models/${model.id}/versions`, {
        method: 'POST',
        cookie: editor.cookie,
        body: { weightsUri: 'https://weights.example.test/model.bin', metadata: { epochs: 3 } },
      }),
      { method: 'post', path: '/api/projects/:p/models/:id/versions', status: 201 },
    );
    await conforms(
      await request(harness.app, `${basePath}/models/${model.id}/aliases/production`, {
        method: 'PUT',
        cookie: editor.cookie,
        body: { versionId: version.id },
      }),
      { method: 'put', path: '/api/projects/:p/models/:id/aliases/:alias', status: 200 },
    );
    await conforms(await request(harness.app, `${basePath}/models`, { cookie: viewer.cookie }), {
      method: 'get',
      path: '/api/projects/:p/models',
      status: 200,
    });
    await conforms(
      await request(harness.app, `${basePath}/models/${model.id}/versions`, {
        cookie: viewer.cookie,
      }),
      { method: 'get', path: '/api/projects/:p/models/:id/versions', status: 200 },
    );
    await conforms(
      await request(harness.app, `${basePath}/model-versions/${version.id}`, {
        cookie: viewer.cookie,
      }),
      { method: 'get', path: '/api/projects/:p/model-versions/:id', status: 200 },
    );
  });

  it('Taskの作成・起動・履歴の応答がschemaに適合する', async () => {
    const fixture = await workbenchFixture(harness);
    const { basePath, editor, viewer } = fixture;
    await conforms<ExperimentTask>(
      await request(harness.app, fixture.taskPath, { cookie: viewer.cookie }),
      {
        method: 'get',
        path: '/api/projects/:p/tasks/:id',
        status: 200,
      },
    );
    const launched = await conforms<{ run: Run }>(
      await request(harness.app, `${fixture.taskPath}/launch`, {
        method: 'POST',
        cookie: editor.cookie,
        body: { expectedRevision: fixture.task.revision },
      }),
      { method: 'post', path: '/api/projects/:p/tasks/:id/launch', status: 201 },
    );
    expect(launched.run.executionSnapshot).not.toBeNull();
    await conforms(
      await request(harness.app, `${fixture.taskPath}/runs`, { cookie: viewer.cookie }),
      {
        method: 'get',
        path: '/api/projects/:p/tasks/:id/runs',
        status: 200,
      },
    );
    await conforms(await request(harness.app, `${basePath}/jobs`, { cookie: viewer.cookie }), {
      method: 'get',
      path: '/api/projects/:p/jobs',
      status: 200,
    });
  });

  it('自動実行ruleと実行履歴の応答がschemaに適合する', async () => {
    const fixture = await executionFixture(harness);
    const { basePath, administrator, viewer } = fixture;
    await conforms<ModelAutomationRule>(
      await request(harness.app, `${basePath}/automation-rules`, {
        method: 'POST',
        cookie: administrator.cookie,
        body: {
          name: 'Conformance inference',
          modelFamilies: ['qwen2'],
          kind: 'inference',
          experimentId: fixture.experiment.id,
          codeVersionId: fixture.codeVersion.id,
          targetId: fixture.target.id,
          summaryMetrics: ['accuracy'],
        },
      }),
      { method: 'post', path: '/api/projects/:p/automation-rules', status: 201 },
    );
    // Registering a version of the rule's family starts the rule, so the history has an entry.
    await request(harness.app, `${basePath}/models/${fixture.model.id}/versions`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { weightsUri: 'https://weights.example.test/next.bin' },
    });
    await conforms(
      await request(harness.app, `${basePath}/automation-rules`, { cookie: viewer.cookie }),
      {
        method: 'get',
        path: '/api/projects/:p/automation-rules',
        status: 200,
      },
    );
    const executions = await conforms<{ items: unknown[] }>(
      await request(harness.app, `${basePath}/automation-executions`, { cookie: viewer.cookie }),
      { method: 'get', path: '/api/projects/:p/automation-executions', status: 200 },
    );
    expect(executions.items).toHaveLength(1);
  });

  it('upload sessionの作成・part・完了・取得の応答がschemaに適合する', async () => {
    const fixture = await executionFixture(harness);
    const { basePath, editor } = fixture;
    const upload = await conforms<ArtifactUpload>(
      await request(harness.app, `${basePath}/artifact-uploads`, {
        method: 'POST',
        cookie: editor.cookie,
        body: { path: 'reports/conformance.txt', expectedSize: UPLOAD_CONTENT.length },
      }),
      { method: 'post', path: '/api/projects/:p/artifact-uploads', status: 201 },
    );
    const uploadPath = `${basePath}/artifact-uploads/${upload.id}`;
    await conforms(
      await request(harness.app, `${uploadPath}/parts/1`, {
        method: 'PUT',
        cookie: editor.cookie,
        headers: { 'Content-Length': String(UPLOAD_CONTENT.length) },
        binary: UPLOAD_CONTENT,
      }),
      { method: 'put', path: '/api/projects/:p/artifact-uploads/:u/parts/:n', status: 200 },
    );
    await conforms(
      await request(harness.app, `${uploadPath}/complete`, {
        method: 'POST',
        cookie: editor.cookie,
      }),
      {
        method: 'post',
        path: '/api/projects/:p/artifact-uploads/:u/complete',
        status: 202,
      },
    );
    await harness.artifactUploadFinalizer.finalizeBatch();
    const completed = await conforms<ArtifactUpload>(
      await request(harness.app, uploadPath, { cookie: editor.cookie }),
      { method: 'get', path: '/api/projects/:p/artifact-uploads/:u', status: 200 },
    );
    expect(completed.status).toBe('completed');
    await conforms(
      await request(harness.app, `${basePath}/artifact-uploads`, { cookie: editor.cookie }),
      {
        method: 'get',
        path: '/api/projects/:p/artifact-uploads',
        status: 200,
      },
    );
    await conforms(
      await request(harness.app, `${basePath}/artifacts/${completed.artifactId}`, {
        cookie: editor.cookie,
      }),
      { method: 'get', path: '/api/projects/:p/artifacts/:a', status: 200 },
    );
  });
});
