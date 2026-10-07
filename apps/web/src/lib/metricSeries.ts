import type { MetricPoint } from '@mmt/contracts';

export interface MetricSeries {
  id: string;
  label: string;
  points: MetricPoint[];
}
export function buildMetricRows(
  series: MetricSeries[],
  metric: string,
): Array<Record<string, number>> {
  const byStep = new Map<number, Record<string, number>>();
  for (const item of series) {
    for (const point of [...item.points].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    )) {
      if (point.name !== metric) continue;
      const row = byStep.get(point.step) ?? { step: point.step };
      row[item.id] = point.value;
      byStep.set(point.step, row);
    }
  }
  return [...byStep.values()].sort((left, right) => (left.step ?? 0) - (right.step ?? 0));
}
export const getMetricNames = (series: MetricSeries[]) =>
  Array.from(new Set(series.flatMap((item) => item.points.map((point) => point.name)))).sort();
export const isSystemMetric = (name: string) =>
  /^(system[./]|gpu[./]|cpu[./]|memory[./])/.test(name);
