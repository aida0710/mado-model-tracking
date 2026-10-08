import type {
  SweepCreate,
  SweepEarlyStopping,
  SweepMethod,
  SweepParameterDefinition,
  SweepParameterValue,
} from '@mmt/contracts';
import { text, textTemplates } from '../i18n/catalog';

/**
 * The three forms of a sweep's search settings: the W&B sweep config pasted as JSON, the editor
 * rows of the create dialog, and the API body. The W&B conversion follows docs/sweeps.md ("W&B 形式
 * の config の変換規則") and python/src/mado_tracking/sweep_config.py; change all three together.
 * Unknown keys are errors rather than ignored, because a dropped key would run a different search.
 */

export type SweepSearchSettings = Pick<
  SweepCreate,
  'method' | 'searchSpace' | 'objective' | 'maxTrials' | 'parallelism' | 'earlyStopping'
>;

/** A config the screen cannot convert; the message names the key or parameter. */
export class SweepConfigError extends Error {
  override name = 'SweepConfigError';
}

const SWEEP_METHODS: readonly SweepMethod[] = ['grid', 'random', 'bayes'];
const METRIC_GOALS = ['minimize', 'maximize'] as const;
const OBJECTIVE_AGGREGATIONS = ['last', 'min', 'max'] as const;
// W&B distribution name → API distribution. log_uniform_values takes the values themselves, which
// is what the API's log_uniform means; W&B's own log_uniform (exponents) is rejected.
const WANDB_DISTRIBUTIONS = {
  uniform: 'uniform',
  int_uniform: 'int_uniform',
  q_uniform: 'q_uniform',
  log_uniform_values: 'log_uniform',
} as const;
export type SweepDistribution = (typeof WANDB_DISTRIBUTIONS)[keyof typeof WANDB_DISTRIBUTIONS];
export const SWEEP_DISTRIBUTIONS: readonly SweepDistribution[] = Object.values(WANDB_DISTRIBUTIONS);
// W&B's default eta for hyperband.
export const DEFAULT_HYPERBAND_ETA = 3;
/** The API's grid limit (apps/api/src/domain/sweeps/searchSpace.ts MAX_GRID_COMBINATIONS). */
export const MAX_GRID_COMBINATIONS = 10000;

const CONFIG_KEYS = ['early_terminate', 'method', 'metric', 'parallelism', 'parameters', 'run_cap'];
const METRIC_KEYS = ['aggregation', 'goal', 'name'];
const EARLY_TERMINATE_KEYS = ['eta', 'max_iter', 'min_iter', 'type'];

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isParameterValue = (value: unknown): value is SweepParameterValue =>
  typeof value === 'string' || typeof value === 'boolean' || isNumber(value);

function rejectUnknownKeys(where: string, record: JsonRecord, allowed: string[]): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length)
    throw new SweepConfigError(textTemplates.sweepConfigUnsupportedKeys(where, unknown, allowed));
}

function positiveInteger(key: string, value: unknown): number {
  if (!isNumber(value) || !Number.isInteger(value) || value < 1)
    throw new SweepConfigError(textTemplates.sweepConfigPositiveInteger(key));
  return value;
}

function oneOf<T extends string>(key: string, value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new SweepConfigError(textTemplates.sweepConfigOneOf(key, allowed));
  return value as T;
}

/** Converts a W&B sweep config (already parsed from JSON) into the API's search settings. */
export function convertWandbSweepConfig(config: unknown): SweepSearchSettings {
  if (!isRecord(config)) throw new SweepConfigError(textTemplates.sweepConfigNotObject('sweep config'));
  rejectUnknownKeys('sweep config', config, CONFIG_KEYS);
  const settings: SweepSearchSettings = {
    method: oneOf('method', config.method, SWEEP_METHODS),
    searchSpace: convertParameters(config.parameters),
    objective: convertMetric(config.metric),
    maxTrials: positiveInteger('run_cap', config.run_cap),
  };
  if ('parallelism' in config) settings.parallelism = positiveInteger('parallelism', config.parallelism);
  if ('early_terminate' in config) settings.earlyStopping = convertEarlyTerminate(config.early_terminate);
  return settings;
}

function convertMetric(metric: unknown): SweepSearchSettings['objective'] {
  if (!isRecord(metric)) throw new SweepConfigError(textTemplates.sweepConfigNotObject('metric'));
  rejectUnknownKeys('metric', metric, METRIC_KEYS);
  if (typeof metric.name !== 'string' || !metric.name.trim())
    throw new SweepConfigError(textTemplates.sweepConfigNonEmptyString('metric.name'));
  const objective: SweepSearchSettings['objective'] = {
    metric: metric.name,
    goal: oneOf('metric.goal', metric.goal, METRIC_GOALS),
  };
  // aggregation is a Mado extension; omitted means the server default (last).
  if ('aggregation' in metric)
    objective.aggregation = oneOf('metric.aggregation', metric.aggregation, OBJECTIVE_AGGREGATIONS);
  return objective;
}

function convertParameters(parameters: unknown): Record<string, SweepParameterDefinition> {
  if (!isRecord(parameters) || Object.keys(parameters).length === 0)
    throw new SweepConfigError(textTemplates.sweepConfigNotObject('parameters'));
  return Object.fromEntries(
    Object.entries(parameters).map(([name, definition]) => {
      if (!name) throw new SweepConfigError(textTemplates.sweepConfigParameterName());
      return [name, convertParameter(name, definition)];
    }),
  );
}

function convertParameter(name: string, definition: unknown): SweepParameterDefinition {
  if (!isRecord(definition)) throw new SweepConfigError(textTemplates.sweepConfigNotObject(`parameter「${name}」`));
  if ('parameters' in definition) throw new SweepConfigError(textTemplates.sweepConfigParameterNested(name));
  const where = `parameter「${name}」`;
  const distribution = definition.distribution;
  if (distribution === 'categorical' || (distribution === undefined && 'values' in definition)) {
    rejectUnknownKeys(where, definition, ['distribution', 'values']);
    const values = definition.values;
    if (!Array.isArray(values) || !values.every(isParameterValue))
      throw new SweepConfigError(textTemplates.sweepConfigParameterValues(name));
    return { values: [...values] };
  }
  if (distribution === 'constant' || (distribution === undefined && 'value' in definition)) {
    rejectUnknownKeys(where, definition, ['distribution', 'value']);
    if (!isParameterValue(definition.value))
      throw new SweepConfigError(textTemplates.sweepConfigParameterValue(name));
    return { value: definition.value };
  }
  if (distribution === 'log_uniform')
    throw new SweepConfigError(textTemplates.sweepConfigParameterLogUniform(name));
  const wandbDistribution = distribution ?? inferredDistribution(name, definition);
  if (typeof wandbDistribution !== 'string' || !(wandbDistribution in WANDB_DISTRIBUTIONS))
    throw new SweepConfigError(textTemplates.sweepConfigParameterDistribution(name, String(wandbDistribution)));
  const apiDistribution = WANDB_DISTRIBUTIONS[wandbDistribution as keyof typeof WANDB_DISTRIBUTIONS];
  rejectUnknownKeys(where, definition, ['distribution', 'max', 'min', ...(apiDistribution === 'q_uniform' ? ['q'] : [])]);
  const { min, max } = definition;
  if (!isNumber(min) || !isNumber(max))
    throw new SweepConfigError(textTemplates.sweepConfigParameterNumbers(name, 'min・max'));
  if (!('q' in definition)) return { distribution: apiDistribution, min, max };
  if (!isNumber(definition.q)) throw new SweepConfigError(textTemplates.sweepConfigParameterNumbers(name, 'q'));
  return { distribution: apiDistribution, min, max, q: definition.q };
}

/**
 * W&B infers the distribution from min/max: both integers → int_uniform, otherwise uniform.
 * JSON.parse reads 1.0 as 1, so "1.0" counts as an integer here (the SDK sees a float).
 */
function inferredDistribution(name: string, definition: JsonRecord): string {
  if (!('min' in definition) || !('max' in definition))
    throw new SweepConfigError(textTemplates.sweepConfigParameterShape(name));
  return Number.isInteger(definition.min) && Number.isInteger(definition.max) ? 'int_uniform' : 'uniform';
}

function convertEarlyTerminate(earlyTerminate: unknown): SweepEarlyStopping {
  if (!isRecord(earlyTerminate)) throw new SweepConfigError(textTemplates.sweepConfigNotObject('early_terminate'));
  rejectUnknownKeys('early_terminate', earlyTerminate, EARLY_TERMINATE_KEYS);
  oneOf('early_terminate.type', earlyTerminate.type, ['hyperband']);
  const stopping: SweepEarlyStopping = {
    type: 'hyperband',
    minIter: positiveInteger('early_terminate.min_iter', earlyTerminate.min_iter),
    eta: positiveInteger('early_terminate.eta', earlyTerminate.eta ?? DEFAULT_HYPERBAND_ETA),
  };
  if ('max_iter' in earlyTerminate)
    stopping.maxIter = positiveInteger('early_terminate.max_iter', earlyTerminate.max_iter);
  return stopping;
}

/** The W&B config for the API's settings: what the JSON editor shows for the current form. */
export function toWandbSweepConfig(settings: SweepSearchSettings): JsonRecord {
  const metric: JsonRecord = { name: settings.objective.metric, goal: settings.objective.goal };
  if (settings.objective.aggregation) metric.aggregation = settings.objective.aggregation;
  const config: JsonRecord = {
    method: settings.method,
    metric,
    parameters: Object.fromEntries(
      Object.entries(settings.searchSpace).map(([name, definition]) => [name, toWandbParameter(definition)]),
    ),
    run_cap: settings.maxTrials,
  };
  if (settings.parallelism !== undefined) config.parallelism = settings.parallelism;
  if (settings.earlyStopping) {
    const { minIter, eta, maxIter } = settings.earlyStopping;
    config.early_terminate = { type: 'hyperband', min_iter: minIter, eta, ...(maxIter ? { max_iter: maxIter } : {}) };
  }
  return config;
}

function toWandbParameter(definition: SweepParameterDefinition): JsonRecord {
  if ('values' in definition) return { values: definition.values };
  if ('value' in definition) return { value: definition.value };
  // The distribution is always written: W&B would infer int_uniform for an integer uniform range.
  const distribution = definition.distribution === 'log_uniform' ? 'log_uniform_values' : definition.distribution;
  return { distribution, min: definition.min, max: definition.max, ...(definition.q !== undefined ? { q: definition.q } : {}) };
}

/** Grid combinations, or null when a continuous parameter makes the space impossible to enumerate. */
export function countGridCombinations(space: Record<string, SweepParameterDefinition>): number | null {
  let count = 1;
  for (const definition of Object.values(space)) {
    if ('distribution' in definition) return null;
    count *= 'values' in definition ? definition.values.length : 1;
  }
  return count;
}

// ---- Editor rows ----

export type SearchSpaceRowKind = 'values' | 'range' | 'constant';

/** One parameter as typed into the editor; every field stays text until the form is submitted. */
export interface SearchSpaceRow {
  id: string;
  name: string;
  kind: SearchSpaceRowKind;
  values: string;
  value: string;
  distribution: SweepDistribution;
  min: string;
  max: string;
  q: string;
}

export function createSearchSpaceRow(id: string): SearchSpaceRow {
  return { id, name: '', kind: 'values', values: '', value: '', distribution: 'uniform', min: '', max: '', q: '' };
}

const NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Reads one typed value: numbers and true/false keep their type, "quoted" text stays a string. */
export function parseParameterValue(token: string): SweepParameterValue {
  const trimmed = token.trim();
  if (NUMBER_PATTERN.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

/** Comma separated values, or a JSON array when a value itself contains a comma. */
export function parseParameterValues(input: string): SweepParameterValue[] {
  const trimmed = input.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every(isParameterValue)) return parsed;
    } catch {
      // Not JSON: fall back to the comma separated form below.
    }
  }
  return trimmed ? trimmed.split(',').map(parseParameterValue).filter((value) => value !== '') : [];
}

/** The text form of values that parseParameterValues reads back to the same values. */
export function formatParameterValues(values: SweepParameterValue[]): string {
  const isAmbiguous = (value: SweepParameterValue) =>
    typeof value === 'string' &&
    (value.includes(',') || value.trim() !== value || parseParameterValue(value) !== value);
  return values.some(isAmbiguous) ? JSON.stringify(values) : values.map(String).join(', ');
}

function formatParameterValue(value: SweepParameterValue): string {
  return typeof value === 'string' && parseParameterValue(value) !== value ? JSON.stringify(value) : String(value);
}

export function searchSpaceToRows(
  space: Record<string, SweepParameterDefinition>,
  createId: () => string,
): SearchSpaceRow[] {
  return Object.entries(space).map(([name, definition]) => {
    const row = { ...createSearchSpaceRow(createId()), name };
    if ('values' in definition) return { ...row, kind: 'values', values: formatParameterValues(definition.values) };
    if ('value' in definition) return { ...row, kind: 'constant', value: formatParameterValue(definition.value) };
    return {
      ...row,
      kind: 'range',
      distribution: definition.distribution,
      min: String(definition.min),
      max: String(definition.max),
      q: definition.q === undefined ? '' : String(definition.q),
    };
  });
}

export interface SearchSpaceFromRows {
  searchSpace: Record<string, SweepParameterDefinition>;
  /** Input errors by row id. The search space is only sent when this is empty. */
  rowErrors: Record<string, string>;
}

/** Builds the API search space; value checks such as min < max are left to the API's 422. */
export function rowsToSearchSpace(rows: SearchSpaceRow[], method: SweepMethod): SearchSpaceFromRows {
  const searchSpace: Record<string, SweepParameterDefinition> = {};
  const rowErrors: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const error = !name
      ? text.sweepNameRequired
      : name in searchSpace
        ? text.sweepNameDuplicate
        : method === 'grid' && row.kind === 'range'
          ? text.sweepGridContinuous
          : null;
    const definition = error ? null : rowDefinition(row);
    if (error || typeof definition === 'string') rowErrors[row.id] = error ?? (definition as string);
    else if (definition) searchSpace[name] = definition;
  }
  return { searchSpace, rowErrors };
}

/** The row's definition, or the input error to show on the row. */
function rowDefinition(row: SearchSpaceRow): SweepParameterDefinition | string {
  if (row.kind === 'values') {
    const values = parseParameterValues(row.values);
    return values.length ? { values } : text.sweepValuesRequired;
  }
  if (row.kind === 'constant') return row.value.trim() ? { value: parseParameterValue(row.value) } : text.sweepValueRequired;
  const [min, max] = [row.min, row.max].map((value) => (NUMBER_PATTERN.test(value.trim()) ? Number(value) : null));
  if (min === null || max === null || min === undefined || max === undefined) return text.sweepNumberRequired;
  if (row.distribution !== 'q_uniform' || !row.q.trim()) return { distribution: row.distribution, min, max };
  if (!NUMBER_PATTERN.test(row.q.trim())) return text.sweepQNumber;
  return { distribution: row.distribution, min, max, q: Number(row.q) };
}

/**
 * The row a 422 sweep_space_invalid message is about. The API names the parameter as「name」
 * (apps/api/src/domain/sweeps/searchSpace.ts); a message that names none belongs to the whole space.
 */
export function rowIdForSpaceError(message: string, rows: SearchSpaceRow[]): string | null {
  return rows.find((row) => row.name.trim() && message.includes(`「${row.name.trim()}」`))?.id ?? null;
}
