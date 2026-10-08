import {
  ANALYSIS_MAX_PARAMS,
  type JsonValue,
  type RunAnalysisParam,
  type RunAnalysisRange,
} from '@mmt/contracts';
// The importance calculation's rule, so the table and the importance agree on which params are numeric.
import { NUMERIC_STRING_PATTERN } from './analysis/parameterMatrix.js';

export type RunParameters = Record<string, JsonValue>;

function hasValue(value: JsonValue | undefined): value is JsonValue {
  return value !== undefined && value !== null;
}

function compareCodeUnits(left: string, right: string): number {
  // localeCompare would depend on the server locale.
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNumericValue(value: JsonValue): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && NUMERIC_STRING_PATTERN.test(value.trim());
}

/** The string a categorical value is shown and grouped by, as parameterMatrix.ts compares them. */
function categoryLabel(value: JsonValue): string {
  if (typeof value === 'string') return value;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function coverageOf(runs: RunParameters[], key: string): number {
  if (!runs.length) return 0;
  return runs.filter((parameters) => hasValue(parameters[key])).length / runs.length;
}

/**
 * The requested params, or every param with a value. When more than ANALYSIS_MAX_PARAMS have a
 * value, the best covered ones are kept (ties by name) and returned in name order.
 */
export function selectAnalysisParams(
  runs: RunParameters[],
  requested: string[] | undefined,
): string[] {
  if (requested) return requested;
  const counts = new Map<string, number>();
  for (const parameters of runs)
    for (const [key, value] of Object.entries(parameters))
      if (hasValue(value)) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .sort(
      ([leftKey, left], [rightKey, right]) => right - left || compareCodeUnits(leftKey, rightKey),
    )
    .slice(0, ANALYSIS_MAX_PARAMS)
    .map(([key]) => key)
    .sort(compareCodeUnits);
}

export function describeAnalysisParams(runs: RunParameters[], keys: string[]): RunAnalysisParam[] {
  return keys.map((key): RunAnalysisParam => {
    const values = runs.map((parameters) => parameters[key]).filter(hasValue);
    const coverage = coverageOf(runs, key);
    if (values.every(isNumericValue)) return { key, kind: 'numeric', coverage };
    const levels = [...new Set(values.map(categoryLabel))].sort(compareCodeUnits);
    return { key, kind: 'categorical', values: levels, coverage };
  });
}

/** Keeps only the selected params that have a value. */
export function pickParams(parameters: RunParameters, keys: string[]): RunParameters {
  return Object.fromEntries(
    keys.flatMap((key) => (hasValue(parameters[key]) ? [[key, parameters[key]]] : [])),
  );
}

/** PostgreSQL turns non-finite doubles into JSON strings when building latest_metrics. */
export function parseLatestMetricValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') return Number(value);
  return undefined;
}

/** JSON has no NaN or infinity, so a logged but non-finite value becomes null. */
export function toResponseMetric(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function finiteRange(values: readonly (number | null | undefined)[]): RunAnalysisRange {
  let min: number | null = null;
  let max: number | null = null;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    min = min === null ? value : Math.min(min, value);
    max = max === null ? value : Math.max(max, value);
  }
  return { min, max };
}
