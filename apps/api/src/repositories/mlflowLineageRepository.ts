import type { LineageEdge, LineageGraph } from '@mmt/contracts';
import { rows, type Database } from '../db/database.js';

interface LoggedModelNode {
  id: string;
  name: string;
  sourceRunId: string | null;
  status: string;
}

export async function getMlflowLineage(
  database: Database,
  projectId: string,
): Promise<LineageGraph> {
  const [models, inputs, registrations] = await Promise.all([
    rows<LoggedModelNode>(
      database,
      'SELECT id,name,source_run_id,status FROM mlflow_logged_models WHERE project_id=$1',
      [projectId],
    ),
    rows<{ runId: string; modelId: string }>(
      database,
      'SELECT run_id,model_id FROM mlflow_run_model_inputs WHERE project_id=$1',
      [projectId],
    ),
    rows<{ versionId: string; loggedModelId: string }>(
      database,
      'SELECT version_id,logged_model_id FROM mlflow_model_version_metadata WHERE project_id=$1 AND logged_model_id IS NOT NULL',
      [projectId],
    ),
  ]);
  const edges: LineageEdge[] = models
    .filter((model) => model.sourceRunId)
    .map((model) => ({
      source: model.sourceRunId!,
      target: model.id,
      relation: 'outputModel',
    }));
  edges.push(
    ...inputs.map((input) => ({ source: input.modelId, target: input.runId, relation: 'model' })),
  );
  edges.push(
    ...registrations.map((registration) => ({
      source: registration.loggedModelId,
      target: registration.versionId,
      relation: 'registeredModel',
    })),
  );
  return {
    nodes: models.map((model) => ({
      id: model.id,
      kind: 'loggedModel',
      label: model.name,
      status: model.status,
      ...(model.sourceRunId ? { sourceRunId: model.sourceRunId } : {}),
    })),
    edges,
  };
}
