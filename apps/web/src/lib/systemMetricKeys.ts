// Sorts system metrics recorded by the Mado worker/SDK (`system.cpu.percent`,
// `system.gpu.0.utilization_percent`, ...) and by MLflow's system metrics logging
// (`system/cpu_utilization_percentage`, `system/gpu_0_utilization_percentage`, ...) into the
// same categories and units, so both kinds of Run open with the same panels. The name mapping is
// the table in docs/worker.md「MLflowの`system/`名との対応」.

import type { ChartValueUnit } from './chartTicks';

export type SystemMetricCategory = 'cpu' | 'memory' | 'disk' | 'network' | 'gpu' | 'other';
/**
 * `bytes_total` is MLflow's network counter: megabytes since monitoring started, not a rate, so it
 * gets its own panel instead of sharing one with the Mado per-second values.
 */
export type SystemMetricUnit =
  | 'percent'
  | 'bytes'
  | 'bytes_per_second'
  | 'bytes_total'
  | 'load'
  | 'celsius'
  | 'watts'
  | 'value';

export interface SystemMetricKey {
  key: string;
  category: SystemMetricCategory;
  /** The nvidia-smi/NVML index for GPU metrics, null otherwise. */
  gpuIndex: number | null;
  unit: SystemMetricUnit;
  /** Multiplier from the recorded value to the unit; MLflow records megabytes (10^6 bytes). */
  scale: number;
}

const BYTES_PER_MEGABYTE = 1_000_000;
const SYSTEM_PREFIX = /^system[./]/;

export const isSystemMetricKey = (key: string) => SYSTEM_PREFIX.test(key);

// Suffix of the last name part → unit. Longer suffixes first so `_bytes_per_second` wins.
const madoUnits: Array<[string, SystemMetricUnit]> = [
  ['bytes_per_second', 'bytes_per_second'],
  ['bytes', 'bytes'],
  ['percent', 'percent'],
  ['celsius', 'celsius'],
  ['watts', 'watts'],
  ['load1', 'load'],
];
const madoCategories: Record<string, SystemMetricCategory> = {
  cpu: 'cpu',
  memory: 'memory',
  process: 'memory',
  disk: 'disk',
  network: 'network',
  gpu: 'gpu',
};

function classifyMadoKey(key: string): SystemMetricKey {
  const [, area = '', ...rest] = key.split('.');
  const category = madoCategories[area] ?? 'other';
  const gpuIndex = category === 'gpu' && /^\d+$/.test(rest[0] ?? '') ? Number(rest[0]) : null;
  const name = rest.at(-1) ?? '';
  const unit = madoUnits.find(([suffix]) => name.endsWith(suffix))?.[1] ?? 'value';
  return { key, category: category === 'gpu' && gpuIndex === null ? 'other' : category, gpuIndex, unit, scale: 1 };
}

function classifyMlflowKey(key: string): SystemMetricKey {
  const name = key.slice('system/'.length);
  const gpu = /^gpu_(\d+)_/.exec(name);
  const category: SystemMetricCategory = gpu
    ? 'gpu'
    : name.startsWith('cpu_')
      ? 'cpu'
      : name.startsWith('system_memory_')
        ? 'memory'
        : name.startsWith('disk_')
          ? 'disk'
          : name.startsWith('network_')
            ? 'network'
            : 'other';
  const gpuIndex = gpu ? Number(gpu[1]) : null;
  if (name.endsWith('_percentage')) return { key, category, gpuIndex, unit: 'percent', scale: 1 };
  if (name.endsWith('_watts')) return { key, category, gpuIndex, unit: 'watts', scale: 1 };
  if (name.endsWith('_megabytes'))
    return {
      key,
      category,
      gpuIndex,
      unit: category === 'network' ? 'bytes_total' : 'bytes',
      scale: BYTES_PER_MEGABYTE,
    };
  return { key, category, gpuIndex, unit: 'value', scale: 1 };
}

/** Null for a key that is not a system metric. */
export function classifySystemMetricKey(key: string): SystemMetricKey | null {
  if (key.startsWith('system.')) return classifyMadoKey(key);
  if (key.startsWith('system/')) return classifyMlflowKey(key);
  return null;
}

/** Multiplier that converts a recorded value to the unit of its panel (1 for other metrics). */
export const systemMetricValueScale = (key: string) => classifySystemMetricKey(key)?.scale ?? 1;

const valueUnitOfSystemUnit: Partial<Record<SystemMetricUnit, ChartValueUnit>> = {
  bytes: 'bytes',
  bytes_total: 'bytes',
  bytes_per_second: 'bytes_per_second',
};

/** The unit the value axis of a panel shows: a byte unit only when every key measures bytes. */
export function chartValueUnit(keys: readonly string[]): ChartValueUnit {
  const units = new Set(
    keys.map((key) => {
      const unit = classifySystemMetricKey(key)?.unit;
      return (unit && valueUnitOfSystemUnit[unit]) ?? 'number';
    }),
  );
  return units.size === 1 ? [...units][0]! : 'number';
}

export interface SystemMetricPanelGroup {
  /** Stable across Runs with either naming, e.g. `gpu.0.percent`. */
  id: string;
  category: SystemMetricCategory;
  gpuIndex: number | null;
  unit: SystemMetricUnit;
  metricKeys: string[];
}

const categoryOrder: SystemMetricCategory[] = ['cpu', 'memory', 'disk', 'network', 'gpu', 'other'];
const unitOrder: SystemMetricUnit[] = [
  'percent',
  'bytes',
  'bytes_per_second',
  'bytes_total',
  'load',
  'celsius',
  'watts',
  'value',
];

/**
 * One group per category, GPU index and unit, in a fixed order (CPU, memory, disk, network, each
 * GPU, then the rest). Unrecognized system names each get their own group rather than being
 * mixed into a panel whose unit they may not share.
 */
export function groupSystemMetricKeys(keys: string[]): SystemMetricPanelGroup[] {
  const groups = new Map<string, SystemMetricPanelGroup>();
  for (const key of [...new Set(keys)].sort()) {
    const metric = classifySystemMetricKey(key);
    if (!metric) continue;
    const id =
      metric.category === 'other' || metric.unit === 'value'
        ? `other.${key}`
        : [metric.category, metric.gpuIndex, metric.unit].filter((part) => part !== null).join('.');
    const group = groups.get(id) ?? {
      id,
      category: metric.unit === 'value' ? 'other' : metric.category,
      gpuIndex: metric.unit === 'value' ? null : metric.gpuIndex,
      unit: metric.unit,
      metricKeys: [],
    };
    group.metricKeys.push(key);
    groups.set(id, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category) ||
      (left.gpuIndex ?? 0) - (right.gpuIndex ?? 0) ||
      unitOrder.indexOf(left.unit) - unitOrder.indexOf(right.unit) ||
      left.id.localeCompare(right.id),
  );
}
