import type { SweepCreate, SweepMethod, SweepObjective } from '@mmt/contracts';
import { text } from '../i18n/catalog';
import {
  DEFAULT_HYPERBAND_ETA,
  createSearchSpaceRow,
  rowsToSearchSpace,
  searchSpaceToRows,
  type SearchSpaceRow,
  type SweepSearchSettings,
} from './sweepConfig';

/** The create dialog's inputs as typed. Numbers stay text until buildSweepCreate reads them. */
export interface SweepFormValues {
  name: string;
  taskId: string;
  /** '' uses the Task's target. */
  targetId: string;
  /** Comma separated; '' uses the Task's GPUs. */
  gpuIds: string;
  method: SweepMethod;
  metric: string;
  goal: SweepObjective['goal'];
  aggregation: SweepObjective['aggregation'];
  maxTrials: string;
  parallelism: string;
  earlyStopping: 'none' | 'hyperband';
  minIter: string;
  eta: string;
  maxIter: string;
  /** '' lets the server pick the seed. */
  seed: string;
  rows: SearchSpaceRow[];
}

export type SweepFormField = 'name' | 'taskId' | 'metric' | 'maxTrials' | 'parallelism' | 'minIter' | 'eta' | 'maxIter' | 'seed';

// Sensible first values: a short sweep that does not crowd a shared target.
const DEFAULT_MAX_TRIALS = 10;
const DEFAULT_PARALLELISM = 1;
const DEFAULT_MIN_ITER = 1;

export function initialSweepForm(taskId: string, createRowId: () => string): SweepFormValues {
  return {
    name: '',
    taskId,
    targetId: '',
    gpuIds: '',
    method: 'random',
    metric: '',
    goal: 'minimize',
    aggregation: 'last',
    maxTrials: String(DEFAULT_MAX_TRIALS),
    parallelism: String(DEFAULT_PARALLELISM),
    earlyStopping: 'none',
    minIter: String(DEFAULT_MIN_ITER),
    eta: String(DEFAULT_HYPERBAND_ETA),
    maxIter: '',
    seed: '',
    rows: [createSearchSpaceRow(createRowId())],
  };
}

/** Replaces the search settings with those read from a W&B config; name, Task and target stay. */
export function applySearchSettings(
  form: SweepFormValues,
  settings: SweepSearchSettings,
  createRowId: () => string,
): SweepFormValues {
  const stopping = settings.earlyStopping;
  return {
    ...form,
    method: settings.method,
    metric: settings.objective.metric,
    goal: settings.objective.goal,
    aggregation: settings.objective.aggregation ?? 'last',
    maxTrials: String(settings.maxTrials),
    parallelism: String(settings.parallelism ?? DEFAULT_PARALLELISM),
    earlyStopping: stopping ? 'hyperband' : 'none',
    minIter: String(stopping?.minIter ?? DEFAULT_MIN_ITER),
    eta: String(stopping?.eta ?? DEFAULT_HYPERBAND_ETA),
    maxIter: stopping?.maxIter ? String(stopping.maxIter) : '',
    rows: searchSpaceToRows(settings.searchSpace, createRowId),
  };
}

export interface SweepFormResult {
  /** Set only when every input could be read. */
  input: SweepCreate | null;
  fieldErrors: Partial<Record<SweepFormField, string>>;
  rowErrors: Record<string, string>;
  /** An error about the whole search space rather than one row. */
  searchSpaceError: string | null;
}

const INTEGER_PATTERN = /^\d+$/;

function readInteger(value: string, minimum: number): number | null {
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= minimum ? parsed : null;
}

/**
 * Reads the form into the create body. Only the input form is checked here; the API's 422 decides
 * value ranges (maxTrials up to 10000, min < max and so on) so the two never disagree.
 */
export function buildSweepCreate(form: SweepFormValues): SweepFormResult {
  const fieldErrors: SweepFormResult['fieldErrors'] = {};
  const { searchSpace, rowErrors } = rowsToSearchSpace(form.rows, form.method);
  const integer = (field: SweepFormField, value: string, minimum = 1) => {
    const parsed = readInteger(value, minimum);
    if (parsed === null) fieldErrors[field] = minimum === 0 ? text.sweepSeedError : text.positiveNumberError;
    return parsed ?? 0;
  };
  if (!form.name.trim()) fieldErrors.name = text.required;
  if (!form.taskId) fieldErrors.taskId = text.required;
  if (!form.metric.trim()) fieldErrors.metric = text.sweepObjectiveRequired;
  const maxTrials = integer('maxTrials', form.maxTrials);
  const parallelism = integer('parallelism', form.parallelism);
  const seed = form.seed.trim() ? integer('seed', form.seed, 0) : undefined;
  const earlyStopping =
    form.earlyStopping === 'hyperband'
      ? {
          type: 'hyperband' as const,
          minIter: integer('minIter', form.minIter),
          eta: integer('eta', form.eta),
          ...(form.maxIter.trim() ? { maxIter: integer('maxIter', form.maxIter) } : {}),
        }
      : null;
  const gpuIds = form.gpuIds.split(',').map((id) => id.trim()).filter(Boolean);
  const searchSpaceError = form.rows.length ? null : text.sweepNoParameters;
  const isValid = Object.keys(fieldErrors).length === 0 && Object.keys(rowErrors).length === 0 && !searchSpaceError;
  return {
    input: isValid
      ? {
          name: form.name.trim(),
          taskId: form.taskId,
          method: form.method,
          searchSpace,
          objective: { metric: form.metric.trim(), goal: form.goal, aggregation: form.aggregation },
          maxTrials,
          parallelism,
          earlyStopping,
          ...(seed !== undefined ? { seed } : {}),
          targetId: form.targetId || null,
          gpuIds: gpuIds.length ? gpuIds : null,
        }
      : null,
    fieldErrors,
    rowErrors,
    searchSpaceError,
  };
}

/** The current search settings for the JSON editor, or null while the rows cannot be read. */
export function formSearchSettings(form: SweepFormValues): SweepSearchSettings | null {
  const { searchSpace, rowErrors } = rowsToSearchSpace(form.rows, form.method);
  const maxTrials = readInteger(form.maxTrials, 1);
  const parallelism = readInteger(form.parallelism, 1);
  if (Object.keys(rowErrors).length || !form.rows.length || maxTrials === null || parallelism === null) return null;
  const minIter = readInteger(form.minIter, 1);
  const eta = readInteger(form.eta, 1);
  const maxIter = readInteger(form.maxIter, 1);
  return {
    method: form.method,
    searchSpace,
    objective: { metric: form.metric.trim(), goal: form.goal, aggregation: form.aggregation },
    maxTrials,
    parallelism,
    earlyStopping:
      form.earlyStopping === 'hyperband' && minIter !== null && eta !== null
        ? { type: 'hyperband', minIter, eta, ...(maxIter !== null ? { maxIter } : {}) }
        : null,
  };
}
