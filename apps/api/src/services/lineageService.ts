import type {
  CodeVersion,
  DatasetVersion,
  LineageEdge,
  LineageGraph,
  LineageNode,
  ModelVersion,
  Run,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { rows, type Database } from '../db/database.js';
import { datasetVersionSelect } from '../repositories/registryRepository.js';
import { getMlflowLineage } from '../repositories/mlflowLineageRepository.js';
import { outputModelVersionIdsColumn } from '../repositories/runListProjection.js';
import { requireProject } from './accessService.js';

export class LineageService {
  constructor(private readonly database: Database) {}

  async graph(principal: Principal, projectId: string): Promise<LineageGraph> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const [runs, models, datasets, codes, mlflow] = await Promise.all([
      rows<Run>(
        this.database,
        `SELECT *,${outputModelVersionIdsColumn} FROM runs WHERE project_id=$1`,
        [projectId],
      ),
      rows<ModelVersion & { name: string }>(
        this.database,
        'SELECT v.*,m.family,m.name FROM model_versions v JOIN models m ON m.id=v.model_id WHERE v.project_id=$1',
        [projectId],
      ),
      rows<DatasetVersion>(this.database, `${datasetVersionSelect} WHERE v.project_id=$1`, [
        projectId,
      ]),
      rows<CodeVersion & { name: string }>(
        this.database,
        'SELECT v.*,c.name FROM code_versions v JOIN codes c ON c.id=v.code_id WHERE v.project_id=$1',
        [projectId],
      ),
      getMlflowLineage(this.database, projectId),
    ]);
    const nodes: LineageNode[] = [...mlflow.nodes];
    const edges: LineageEdge[] = [...mlflow.edges];
    for (const run of runs) {
      nodes.push({ id: run.id, kind: 'run', label: run.name, status: run.status });
      if (run.modelVersionId)
        edges.push({ source: run.modelVersionId, target: run.id, relation: 'model' });
      if (run.codeVersionId)
        edges.push({ source: run.codeVersionId, target: run.id, relation: 'code' });
      if (run.parentRunId)
        edges.push({ source: run.parentRunId, target: run.id, relation: 'parentRun' });
      for (const id of run.inputDatasetVersionIds)
        edges.push({ source: id, target: run.id, relation: 'input' });
      // Same derivation as Run.outputModelVersionIds, so deleted versions lose the edge too.
      for (const id of run.outputModelVersionIds)
        edges.push({ source: run.id, target: id, relation: 'outputModel' });
    }
    for (const model of models) {
      nodes.push({ id: model.id, kind: 'modelVersion', label: `${model.name} ${model.version}` });
      for (const id of model.parentModelVersionIds)
        edges.push({ source: id, target: model.id, relation: 'parentModel' });
    }
    for (const dataset of datasets) {
      nodes.push({
        id: dataset.id,
        kind: 'datasetVersion',
        label: `${dataset.name} ${dataset.version}`,
      });
      if (dataset.sourceRunId)
        edges.push({ source: dataset.sourceRunId, target: dataset.id, relation: 'output' });
      for (const id of dataset.parentDatasetVersionIds)
        edges.push({ source: id, target: dataset.id, relation: 'parentDataset' });
    }
    for (const code of codes)
      nodes.push({ id: code.id, kind: 'codeVersion', label: `${code.name} ${code.version}` });
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    };
  }
}
