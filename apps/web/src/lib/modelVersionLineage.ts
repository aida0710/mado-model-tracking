import type {
  AutomatedRunSummary,
  LineageEdge,
  LineageGraph,
  LineageNode,
  Model,
  ModelVersion,
  Run,
} from '@mmt/contracts';

// The band shows the newest results only; the full list is in the tables below it.
export const LINEAGE_RESULT_RUN_LIMIT = 20;

/**
 * training Run → version → inference/evaluation Runs, in the shape LineageGraph draws. A result
 * Run hangs under its parent when the parent is also a result of the version (a chained stage),
 * otherwise under the version itself.
 */
export function buildModelVersionLineage(input: {
  model: Pick<Model, 'name'>;
  version: Pick<ModelVersion, 'id' | 'version' | 'sourceRunId'>;
  sourceRun: Pick<Run, 'id' | 'name' | 'status'> | null;
  resultRuns: readonly Pick<AutomatedRunSummary, 'id' | 'name' | 'status' | 'parentRunId'>[];
}): LineageGraph {
  const { model, version, sourceRun } = input;
  const resultRuns = input.resultRuns.slice(0, LINEAGE_RESULT_RUN_LIMIT);
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  if (version.sourceRunId) {
    nodes.push({
      id: version.sourceRunId,
      kind: 'run',
      label: sourceRun?.name ?? version.sourceRunId,
      ...(sourceRun ? { status: sourceRun.status } : {}),
    });
    edges.push({ source: version.sourceRunId, target: version.id, relation: 'registeredModel' });
  }
  nodes.push({ id: version.id, kind: 'modelVersion', label: `${model.name} / ${version.version}` });
  const resultIds = new Set(resultRuns.map((run) => run.id));
  for (const run of resultRuns) {
    nodes.push({ id: run.id, kind: 'run', label: run.name, status: run.status });
    const isChained = run.parentRunId !== null && resultIds.has(run.parentRunId);
    edges.push(
      isChained
        ? { source: run.parentRunId!, target: run.id, relation: 'parentRun' }
        : { source: version.id, target: run.id, relation: 'model' },
    );
  }
  return { nodes, edges };
}
