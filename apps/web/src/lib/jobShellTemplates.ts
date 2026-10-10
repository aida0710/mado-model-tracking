import type { ExecutionRuntimeKind, SiteGpuAssignment } from '@mmt/contracts';
// The examples of deploy/sites, read as they are so the Web offers exactly what is documented.
import directApptainerJobShell from '../../../../deploy/sites/examples/direct-apptainer/job.sh?raw';
import directDockerJobShell from '../../../../deploy/sites/examples/direct-docker/job.sh?raw';
import fujitsuTcsJobShell from '../../../../deploy/sites/examples/fujitsu-tcs/job.sh?raw';
import gridEngineJobShell from '../../../../deploy/sites/examples/grid-engine/job.sh?raw';
import pbsJobShell from '../../../../deploy/sites/examples/pbs/job.sh?raw';
import slurmJobShell from '../../../../deploy/sites/examples/slurm/job.sh?raw';

export type JobShellTemplateKey =
  | 'pbs'
  | 'slurm'
  | 'grid-engine'
  | 'fujitsu-tcs'
  | 'direct-docker'
  | 'direct-apptainer';

/**
 * A job shell to start a site from, with the settings that go with it: how its scheduler removes
 * a queued job, whether it submits an array in one call, who picks the GPUs and which container
 * runtime its compute nodes offer.
 */
export interface JobShellTemplate {
  key: JobShellTemplateKey;
  content: string;
  cancelCommand: string | null;
  supportsArray: boolean;
  gpuAssignment: SiteGpuAssignment;
  runtimeKinds: ExecutionRuntimeKind[];
}

// The settings each example's README lists for the Web: the cancel command of its scheduler (a
// host without one has no queue to remove a job from) and the runtime its batch script loads.
export const JOB_SHELL_TEMPLATES: readonly JobShellTemplate[] = [
  {
    key: 'pbs',
    content: pbsJobShell,
    cancelCommand: 'qdel "$MMT_SCHEDULER_JOB_ID"',
    supportsArray: true,
    gpuAssignment: 'scheduler',
    runtimeKinds: ['singularity'],
  },
  {
    key: 'slurm',
    content: slurmJobShell,
    cancelCommand: 'scancel "$MMT_SCHEDULER_JOB_ID"',
    supportsArray: true,
    gpuAssignment: 'scheduler',
    runtimeKinds: ['apptainer'],
  },
  {
    key: 'grid-engine',
    content: gridEngineJobShell,
    cancelCommand: 'qdel "$MMT_SCHEDULER_JOB_ID"',
    supportsArray: true,
    gpuAssignment: 'scheduler',
    runtimeKinds: ['apptainer'],
  },
  {
    key: 'fujitsu-tcs',
    content: fujitsuTcsJobShell,
    cancelCommand: 'pjdel "$MMT_SCHEDULER_JOB_ID"',
    supportsArray: true,
    gpuAssignment: 'scheduler',
    runtimeKinds: ['singularity'],
  },
  {
    key: 'direct-docker',
    content: directDockerJobShell,
    cancelCommand: null,
    // Members come one by one, each waiting for free GPUs (examples/direct-docker/README.md).
    supportsArray: false,
    gpuAssignment: 'lease',
    runtimeKinds: ['docker'],
  },
  {
    key: 'direct-apptainer',
    content: directApptainerJobShell,
    cancelCommand: null,
    supportsArray: false,
    gpuAssignment: 'lease',
    runtimeKinds: ['apptainer'],
  },
];

export function findJobShellTemplate(key: string): JobShellTemplate | undefined {
  return JOB_SHELL_TEMPLATES.find((template) => template.key === key);
}
