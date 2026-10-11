import type {
  ComputeTarget,
  DatasetVersion,
  Job,
  JobArrayCreated,
  JobArrayGroup,
  Run,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { assertNoReservedRunTags } from '../domain/reservedRunTags.js';
import type { JobArrayCreateInput } from '../domain/siteExecutionValidation.js';
import { ARRAY_GROUP_TAG, ARRAY_INDEX_TAG } from '../domain/serverRunTags.js';
import { jobColumns } from '../repositories/jobRepository.js';
import { findDatasetVersions } from '../repositories/registryRepository.js';
import { requireProject, requireScope } from './accessService.js';
import type { JobPlacement, JobService } from './jobService.js';
import type { RunService } from './runService.js';

/** Where an array comes from beyond the request: a hook, a driver Job, or neither. */
export interface JobArrayOrigin {
  createdBy: string;
  parentRunId?: string | null;
  serverTags?: Record<string, string>;
  placement?: Omit<JobPlacement, 'arrayGroupId' | 'arrayIndex' | 'datasetPartitionVersionId'>;
  // A driver's key; it names the group so the driver's resend finds the same array.
  idempotencyKey?: string | null;
}

const arrayGroupColumns =
  'id,project_id,target_id,size,created_by,parent_job_id,hook_id,finished_at,created_at';

/**
 * Arrays: one Run and Job per index on a site, submitted together where the site takes arrays
 * (docs/sites.md). Members carry reserved tags with the group and index, and their retries keep
 * the index, so the group ends when every index has a final attempt.
 */
export class JobArrayService {
  private readonly database: Database;
  private readonly runs: RunService;
  private readonly jobs: JobService;
  constructor(options: { database: Database; runs: RunService; jobs: JobService }) {
    this.database = options.database;
    this.runs = options.runs;
    this.jobs = options.jobs;
  }

  async create(
    principal: Principal,
    projectId: string,
    input: JobArrayCreateInput,
  ): Promise<JobArrayCreated> {
    assertNoReservedRunTags(input.tags);
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      requireScope(principal, 'jobs:write');
      return this.insertArray(connection, {
        projectId,
        input,
        origin: { createdBy: principal.user.id },
      });
    });
  }

  async get(principal: Principal, projectId: string, groupId: string): Promise<JobArrayCreated> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return this.describe(this.database, { projectId, groupId });
  }

  async describe(
    connection: Connection,
    reference: { projectId: string; groupId: string },
  ): Promise<JobArrayCreated> {
    const arrayGroup = await first<JobArrayGroup>(
      connection,
      `SELECT ${arrayGroupColumns} FROM job_array_groups WHERE project_id=$1 AND id=$2`,
      [reference.projectId, reference.groupId],
    );
    if (!arrayGroup) notFound('JobArrayGroup');
    const jobs = await rows<Job>(
      connection,
      `SELECT ${jobColumns()} FROM jobs WHERE array_group_id=$1 ORDER BY array_index,attempt`,
      [arrayGroup.id],
    );
    return { arrayGroup, jobs };
  }

  /** Creates the group and every member. Authorization and reserved-tag checks are the caller's. */
  async insertArray(
    connection: Connection,
    request: { projectId: string; input: JobArrayCreateInput; origin: JobArrayOrigin },
  ): Promise<JobArrayCreated> {
    const { projectId, input, origin } = request;
    const target = await first<ComputeTarget>(
      connection,
      'SELECT * FROM compute_targets WHERE id=$1 AND enabled=true',
      [input.targetId],
    );
    if (!target) notFound('ComputeTarget');
    if (target.executor !== 'site')
      throw new DomainError(422, 'arrayはsiteでだけ実行できます', 'site_target_required');
    if (input.datasetPartitionVersionId)
      await assertPartitionVersion(connection, {
        projectId,
        partitionId: input.datasetPartitionVersionId,
        inputIds: input.inputDatasetVersionIds,
      });
    const arrayGroup = (await first<JobArrayGroup>(
      connection,
      `INSERT INTO job_array_groups(project_id,target_id,size,created_by,parent_job_id,idempotency_key,hook_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${arrayGroupColumns}`,
      [
        projectId,
        target.id,
        input.size,
        origin.createdBy,
        origin.placement?.parentJobId ?? null,
        origin.idempotencyKey ?? null,
        origin.placement?.hookId ?? null,
      ],
    ))!;
    const jobs: Job[] = [];
    for (let index = 0; index < input.size; index++) {
      const run = await this.insertMemberRun(connection, {
        projectId,
        input,
        origin,
        arrayGroupId: arrayGroup.id,
        index,
      });
      jobs.push(
        await this.jobs.insertJob(connection, {
          run,
          input: {
            runId: run.id,
            targetId: target.id,
            gpuIds: [],
            gpuCount: input.gpuCount,
            walltimeSeconds: input.walltimeSeconds,
            maxAttempts: input.maxAttempts,
            retryOnFailure: input.retryOnFailure,
            retryOnTimeout: input.retryOnTimeout,
            allowChildJobs: input.allowChildJobs,
          },
          attempt: 1,
          placement: {
            ...origin.placement,
            arrayGroupId: arrayGroup.id,
            arrayIndex: index,
            datasetPartitionVersionId: input.datasetPartitionVersionId,
          },
        }),
      );
    }
    return { arrayGroup, jobs };
  }

  private async insertMemberRun(
    connection: Connection,
    member: {
      projectId: string;
      input: JobArrayCreateInput;
      origin: JobArrayOrigin;
      arrayGroupId: string;
      index: number;
    },
  ): Promise<Run> {
    const { input, origin, index } = member;
    return this.runs.insertRun(connection, {
      projectId: member.projectId,
      createdBy: origin.createdBy,
      input: {
        experimentId: input.experimentId,
        name: `${input.name} [${index}]`,
        kind: input.kind,
        parameters: input.parameters,
        tags: {
          ...input.tags,
          ...origin.serverTags,
          [ARRAY_GROUP_TAG]: member.arrayGroupId,
          [ARRAY_INDEX_TAG]: String(index),
        },
        modelVersionId: input.modelVersionId,
        codeVersionId: input.codeVersionId,
        inputDatasetVersionIds: input.inputDatasetVersionIds,
        parentRunId: origin.parentRunId ?? null,
        environment: {},
      },
    });
  }

}

/** The members split the files of one 'artifacts' input among themselves (docs/sites.md). */
export async function assertPartitionVersion(
  connection: Connection,
  partition: { projectId: string; partitionId: string; inputIds: string[] },
): Promise<void> {
  const [version] = (await findDatasetVersions(connection, {
    projectId: partition.projectId,
    ids: [partition.partitionId],
  })) as [DatasetVersion];
  if (!partition.inputIds.includes(version.id) || version.contentKind !== 'artifacts')
    throw new DomainError(
      422,
      '分割するDatasetVersionは、入力に含まれるartifactsのバージョンにしてください',
      'dataset_partition_invalid',
    );
}
