import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { LineageGraph } from '@mmt/contracts';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { trackingClient } from './mlflow-tracking-fixtures.js';

describe.skipIf(!testDatabaseUrl)('MLflowで記録したモデルのlineage', () => {
  let harness: Harness;
  beforeAll(async () => { harness = await createHarness(); });
  beforeEach(async () => { await harness.reset(); });
  afterAll(async () => { await harness.close(); });

  it('登録前のモデルも生成元Runと使用先Runへ結び、他Projectへ公開しない', async () => {
    const fixture = await projectFixture(harness);
    const tracking = trackingClient(harness.app, fixture);
    const training = await tracking.createRun({ run_name: 'Training' });
    const captured = await entity<{ model: { info: { model_id: string } } }>(
      await tracking.post('/logged-models', {
        experiment_id: fixture.experiment.id,
        source_run_id: training.info.run_id,
        name: 'Unregistered model',
      }), 200,
    );
    const evaluation = await tracking.createRun({ run_name: 'Evaluation' });
    await entity(await tracking.post('/runs/log-inputs', {
      run_id: evaluation.info.run_id,
      models: [{ model_id: captured.model.info.model_id }],
    }), 200);
    const graph = await entity<LineageGraph>(await request(harness.app, `${fixture.basePath}/lineage`, {
      cookie: fixture.viewer.cookie,
    }), 200);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: captured.model.info.model_id, kind: 'loggedModel', sourceRunId: training.info.run_id,
    }));
    expect(graph.edges).toContainEqual({
      source: training.info.run_id, target: captured.model.info.model_id, relation: 'outputModel',
    });
    expect(graph.edges).toContainEqual({
      source: captured.model.info.model_id, target: evaluation.info.run_id, relation: 'model',
    });
    const denied = await request(harness.app, `${fixture.basePath}/lineage`, { cookie: fixture.outsider.cookie });
    expect(denied.status).toBe(403);
    const other = await projectFixture(harness);
    const otherGraph = await entity<LineageGraph>(await request(harness.app, `${other.basePath}/lineage`, {
      cookie: other.viewer.cookie,
    }), 200);
    expect(otherGraph.nodes).not.toContainEqual(expect.objectContaining({ id: captured.model.info.model_id }));
  });
});
