import { Link } from 'react-router-dom';
import type { ComputeTarget, ExperimentTask, TaskOutputModel } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { DetailsList, KeyValues } from './JsonDetails';
import { CodeRuntimeDetails } from './CodeRuntimeDetails';
import { hasOutputModel } from '../lib/taskInput';
import { text } from '../i18n/catalog';

function OutputModelDetails({ outputModel, catalog, base }: {
  outputModel: TaskOutputModel; catalog: ExecutionCatalog; base: string;
}) {
  const model = catalog.models.find((item) => item.id === outputModel.modelId);
  const defaultCode = catalog.codeVersions.find((item) => item.id === outputModel.defaultCodeVersionId);
  return <DetailsList entries={[
    [text.outputModelTarget, outputModel.createModel
      ? `${text.outputModelCreate}: ${outputModel.createModel.name} · ${outputModel.createModel.family}`
      : <Link to={`${base}/models?id=${outputModel.modelId}`}>{model ? `${model.name} · ${model.family}` : outputModel.modelId}</Link>],
    [text.outputModelArtifactPath, <span className="mono">{outputModel.artifactPath}</span>],
    [text.outputModelDefaultCode, outputModel.defaultCodeVersionId
      ? <Link to={`${base}/codes?version=${outputModel.defaultCodeVersionId}`}>{defaultCode?.version ?? outputModel.defaultCodeVersionId}</Link>
      : null],
  ]} />;
}

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
    {hasOutputModel(task.kind) && <section data-testid="task-output-model-details">
      <h3>{text.outputModelSettings}</h3>
      {task.outputModel ? <OutputModelDetails outputModel={task.outputModel} catalog={catalog} base={base} />
        : <p className="muted">{text.outputModelDisabled}</p>}
    </section>}
    {code && <CodeRuntimeDetails version={code} />}
    <details><summary>{text.parameters}</summary><KeyValues values={task.parameters} /></details>
    <details><summary>{text.tags}</summary><KeyValues values={task.tags} /></details>
  </div>;
}
