import {
  MAX_JOB_ARRAY_SIZE,
  MAX_JOB_GPU_COUNT,
  MAX_JOB_WALLTIME_SECONDS,
  MAX_QUEUE_TIMEOUT_SECONDS,
  MIN_QUEUE_TIMEOUT_SECONDS,
  type ComputeTarget,
} from '@mmt/contracts';
import type { CreateJob } from '../api/inputs';
import type { FormValues } from '../types/form';
import { getFieldValue, getSelectedValues } from './formValues';
import { parseMaxAttempts } from './executionValidation';
import { parseClockDuration } from './clockDuration';
import { validateTargetGpuIds } from './runtimeValidation';
import { text } from '../i18n/catalog';
import { computeTextTemplates } from '../i18n/compute';
import { jobsTextTemplates } from '../i18n/jobs';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Sites take a GPU count and a time limit that their job shell passes to the scheduler; ssh and
 * local targets take the GPU IDs the worker reserves on the host.
 */
export const isSiteTarget = (target: Pick<ComputeTarget, 'executor'> | undefined): boolean =>
  target?.executor === 'site';

/** GPUs a site Job asks for; empty or 0 runs on CPU only. */
export function parseGpuCount(value: string): number {
  const trimmed = value.trim();
  const count = trimmed ? Number(trimmed) : 0;
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_JOB_GPU_COUNT)
    throw new Error(text.gpuCountError);
  return count;
}

/** A site Job's time limit in seconds; empty leaves the limit to the site's job shell. */
export function parseWalltime(value: string): number | null {
  const seconds = parseClockDuration(value);
  if (seconds !== null && (seconds <= 0 || seconds > MAX_JOB_WALLTIME_SECONDS))
    throw new Error(jobsTextTemplates.walltimeError(MAX_JOB_WALLTIME_SECONDS / SECONDS_PER_DAY));
  return seconds;
}

/** How long a site Job may wait in the scheduler queue before it fails; empty has no limit. */
export function parseQueueTimeout(value: string): number | null {
  const seconds = parseClockDuration(value);
  if (
    seconds !== null &&
    (seconds < MIN_QUEUE_TIMEOUT_SECONDS || seconds > MAX_QUEUE_TIMEOUT_SECONDS)
  )
    throw new Error(
      computeTextTemplates.queueTimeoutError(
        MIN_QUEUE_TIMEOUT_SECONDS / SECONDS_PER_MINUTE,
        MAX_QUEUE_TIMEOUT_SECONDS / SECONDS_PER_DAY,
      ),
    );
  return seconds;
}

/** Members of a Job array; empty starts a single Job. */
export function parseArraySize(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const size = Number(trimmed);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_JOB_ARRAY_SIZE)
    throw new Error(text.arraySizeError);
  return size;
}

/** What a Job asks of its target: GPU IDs on ssh/local targets, a count and a limit on sites. */
export type JobResourceInput =
  | { gpuIds: string[] }
  | { gpuCount: number; walltimeSeconds: number | null };

/**
 * The resource fields of a Job request from the form fields gpuIds, gpuCount and walltime. The
 * API refuses GPU IDs on a site (site_gpu_ids) and a GPU count elsewhere (site_only_setting), so
 * only the fields of the target's own kind are sent.
 */
export function buildJobResources(target: ComputeTarget, values: FormValues): JobResourceInput {
  const gpuIds = getSelectedValues(values, 'gpuIds');
  if (!isSiteTarget(target)) {
    validateTargetGpuIds(target, gpuIds);
    return { gpuIds };
  }
  if (gpuIds.length) throw new Error(text.siteGpuIdsError);
  return {
    gpuCount: parseGpuCount(getFieldValue(values, 'gpuCount')),
    walltimeSeconds: parseWalltime(getFieldValue(values, 'walltime')),
  };
}

const isChecked = (values: FormValues, name: string) => getFieldValue(values, name) === 'true';

/**
 * A Job request for a Run from the launch form. The automatic retries exist on sites only, and the
 * opt-in flags are sent only when set, so an ssh Job is requested exactly as before sites existed.
 */
export function buildJobRequest(target: ComputeTarget, values: FormValues): Omit<CreateJob, 'runId'> {
  const isSite = isSiteTarget(target);
  return {
    targetId: target.id,
    maxAttempts: parseMaxAttempts(getFieldValue(values, 'maxAttempts')),
    ...buildJobResources(target, values),
    ...(isSite && isChecked(values, 'retryOnFailure') && { retryOnFailure: true }),
    ...(isSite && isChecked(values, 'retryOnTimeout') && { retryOnTimeout: true }),
    ...(isChecked(values, 'allowChildJobs') && { allowChildJobs: true }),
  };
}
