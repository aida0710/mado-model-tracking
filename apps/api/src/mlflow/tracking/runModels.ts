import { first, type Connection } from '../../db/database.js';
import { invalidParameter } from './trackingValidation.js';

export async function logRunModels(
  connection: Connection,
  request: {
    projectId: string;
    runId: string;
    models: { model_id: string; step?: number | string }[];
    direction: 'input' | 'output';
  },
): Promise<void> {
  const models = [...request.models].sort((left, right) =>
    left.model_id.localeCompare(right.model_id),
  );
  for (const reference of models) {
    const model = await first<{ sourceRunId: string | null }>(
      connection,
      'SELECT source_run_id FROM mlflow_logged_models WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE',
      [request.projectId, reference.model_id],
    );
    if (!model) invalidParameter('同じProjectのLogged Modelが必要です');
    if (request.direction === 'output' && model.sourceRunId !== request.runId)
      invalidParameter('出力モデルのsource_run_idがRunと一致しません');
    if (request.direction === 'input') {
      await connection.query(
        'INSERT INTO mlflow_run_model_inputs(project_id,run_id,model_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [request.projectId, request.runId, reference.model_id],
      );
    } else {
      await connection.query(
        'INSERT INTO mlflow_run_model_outputs(project_id,run_id,model_id,step) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [request.projectId, request.runId, reference.model_id, reference.step ?? 0],
      );
    }
  }
}
