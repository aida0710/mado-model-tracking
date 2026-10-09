import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ComputeTarget, ExperimentTask, TaskOutputModel } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { SelectOption } from '../types/form';
import { DetailsList, KeyValues } from './JsonDetails';
import { CodeRuntimeDetails } from './CodeRuntimeDetails';
import { hasOutputModel, outputModelLabel } from '../lib/taskInput';
import { buildCatalogOptions } from '../lib/catalogOptions';
import { formatClockDuration } from '../lib/clockDuration';
import { isSiteTarget } from '../lib/siteExecutionInput';
import { text } from '../i18n/catalog';

function OutputModelDetails({ outputModel, catalog, base }: {
  outputModel: TaskOutputModel; catalog: ExecutionCatalog; base: string;
}) {
  const defaultCode = catalog.codeVersions.find((item) => item.id === outputModel.defaultCodeVersionId);
  return <DetailsList entries={[
    [text.outputModelTarget, outputModel.createModel
      ? `${text.outputModelCreate}: ${outputModelLabel(outputModel, catalog)}`
      : <Link to={`${base}/models?id=${outputModel.modelId}`}>{outputModelLabel(outputModel, catalog)}</Link>],
    [text.outputModelArtifactPath, <span className="mono">{outputModel.artifactPath}</span>],
    [text.outputModelDefaultCode, outputModel.defaultCodeVersionId
      ? <Link to={`${base}/codes?version=${outputModel.defaultCodeVersionId}`}>{defaultCode?.version ?? outputModel.defaultCodeVersionId}</Link>
      : null],
  ]} />;
}

// Versions not in the catalog (e.g. from another page of results) keep their id.
const optionLabel = (options: SelectOption[], id: string) =>
  options.find((option) => option.value === id)?.label ?? id;

export function TaskDetails({ task, catalog, targets }: {
  task: ExperimentTask; catalog: ExecutionCatalog; targets: ComputeTarget[];
}) {
  const base = `/projects/${task.projectId}`;
  const code = catalog.codeVersions.find((item) => item.id === task.codeVersionId);
  const options = buildCatalogOptions(catalog);
  const target = targets.find((item) => item.id === task.targetId);
  // A site Task asks for a GPU count and a time limit; other Tasks name their GPU IDs.
  const resourceEntries: Array<[string, ReactNode]> = isSiteTarget(target)
    ? [[text.gpuCount, task.gpuCount],
      [text.walltimeShort, formatClockDuration(task.walltimeSeconds) || text.walltimeUnset]]
    : [[text.gpuIds, task.gpuIds.join(', ') || text.cpuOnly]];
  return <div className="task-details" data-testid="task-details">
    {task.description && <p>{task.description}</p>}
    <DetailsList entries={[
      [text.taskRevision, <span data-testid="task-revision">{task.revision}</span>],
      [text.experiments, <Link to={`${base}/experiments?experiment=${task.experimentId}`}>{catalog.experiments.find((item) => item.id === task.experimentId)?.name ?? task.experimentId}</Link>],
      [text.kind, text[task.kind]],
      [text.codeVersion, <Link to={`${base}/codes?version=${task.codeVersionId}`}>{code?.version ?? task.codeVersionId}</Link>],
      [text.modelVersion, task.modelVersionId ? <Link to={`${base}/models?version=${task.modelVersionId}`}>{optionLabel(options.models, task.modelVersionId)}</Link> : null],
      [text.inputDatasets, task.inputDatasetVersionIds.length
        ? task.inputDatasetVersionIds.map((id) => <Link key={id} className="version-link" to={`${base}/datasets?version=${id}`}>{optionLabel(options.datasets, id)}</Link>)
        : null],
      [text.target, target?.name ?? task.targetId],
      ...resourceEntries,
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
