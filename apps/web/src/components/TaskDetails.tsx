import { Link } from 'react-router-dom';
import type { ComputeTarget, ExperimentTask } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { DetailsList, KeyValues } from './JsonDetails';
import { CodeRuntimeDetails } from './CodeRuntimeDetails';
import { text } from '../i18n/catalog';

export function TaskDetails({ task, catalog, targets }: {
  task: ExperimentTask; catalog: ExecutionCatalog; targets: ComputeTarget[];
}) {
  const base = `/projects/${task.projectId}`;
  const code = catalog.codeVersions.find((item) => item.id === task.codeVersionId);
  return <div className="task-details" data-testid="task-details">
    {task.description && <p>{task.description}</p>}
    <DetailsList entries={[
      [text.taskRevision, <span data-testid="task-revision">{task.revision}</span>],
      [text.experiments, <Link to={`${base}/experiments?experiment=${task.experimentId}`}>{catalog.experiments.find((item) => item.id === task.experimentId)?.name ?? task.experimentId}</Link>],
      [text.kind, text[task.kind]],
      [text.codeVersion, <Link to={`${base}/codes?version=${task.codeVersionId}`}>{code?.version ?? task.codeVersionId}</Link>],
      [text.modelVersion, task.modelVersionId ? <Link to={`${base}/models?version=${task.modelVersionId}`}>{task.modelVersionId}</Link> : null],
      [text.inputDatasets, task.inputDatasetVersionIds.map((id) => <Link key={id} className="version-link mono" to={`${base}/datasets?version=${id}`}>{id}</Link>)],
      [text.target, targets.find((target) => target.id === task.targetId)?.name ?? task.targetId],
      [text.gpuIds, task.gpuIds.join(', ') || text.cpuOnly],
    ]} />
    {code && <CodeRuntimeDetails version={code} />}
    <details><summary>{text.parameters}</summary><KeyValues values={task.parameters} /></details>
    <details><summary>{text.tags}</summary><KeyValues values={task.tags} /></details>
  </div>;
}
