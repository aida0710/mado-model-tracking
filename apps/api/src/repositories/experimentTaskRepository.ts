import type { ExperimentTask } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import type { TaskCreate, TaskDefaults } from '../domain/experimentTaskValidation.js';
import { notFound } from '../domain/errors.js';

export async function findTask(
  connection: Connection,
  reference: { projectId: string; id: string; lock?: boolean },
): Promise<ExperimentTask> {
  const task = await first<ExperimentTask>(
    connection,
    `SELECT * FROM experiment_tasks WHERE project_id=$1 AND id=$2 ${reference.lock ? 'FOR NO KEY UPDATE' : ''}`,
    [reference.projectId, reference.id],
  );
  if (!task) notFound('ExperimentTask');
  return task;
}

function taskValues(task: TaskDefaults): unknown[] {
  return [
    task.name,
    task.description,
    task.kind,
    task.codeVersionId,
    task.modelVersionId,
    task.inputDatasetVersionIds,
    JSON.stringify(task.parameters),
    JSON.stringify(task.tags),
    task.targetId,
    task.gpuIds,
    task.outputModel ? JSON.stringify(task.outputModel) : null,
    task.gpuCount,
    task.walltimeSeconds,
  ];
}

export async function insertTask(
  connection: Connection,
  registration: { projectId: string; input: TaskCreate },
): Promise<ExperimentTask> {
  return (await first<ExperimentTask>(
    connection,
    `INSERT INTO experiment_tasks(project_id,experiment_id,name,description,kind,code_version_id,model_version_id,input_dataset_version_ids,parameters,tags,target_id,gpu_ids,output_model,gpu_count,walltime_seconds)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15) RETURNING *`,
    [registration.projectId, registration.input.experimentId, ...taskValues(registration.input)],
  ))!;
}

export async function updateTask(
  connection: Connection,
  task: TaskDefaults & { id: string },
): Promise<ExperimentTask> {
  return (await first<ExperimentTask>(
    connection,
    `UPDATE experiment_tasks SET name=$2,description=$3,kind=$4,code_version_id=$5,model_version_id=$6,
    input_dataset_version_ids=$7,parameters=$8::jsonb,tags=$9::jsonb,target_id=$10,gpu_ids=$11,
    output_model=$12::jsonb,gpu_count=$13,walltime_seconds=$14,revision=revision+1
    WHERE id=$1 RETURNING *`,
    [task.id, ...taskValues(task)],
  ))!;
}
