import type { ChartXAxis, RunSet } from '@mmt/contracts';

// Stub for this worktree (sweeps-web): the owner metrics-chart-core-web defines this file for
// the 5th wave and its version wins at integration. Only the props used here are written.

export interface MetricsChartProps {
  series: {
    id: string;
    label: string;
    color?: string;
    points: { x: number; value: number; min?: number; max?: number }[];
    kind: 'run' | 'group';
  }[];
  xAxis: ChartXAxis;
  yScale: 'linear' | 'log';
  smoothing: { kind: 'none' | 'ema' | 'gaussian' | 'running_average'; weight: number };
  showRange: boolean;
  showRaw: boolean;
  markers?: { x: number; label: string }[];
  height?: number;
}

export interface RunAnalysisPanelProps {
  projectId: string;
  runSet: RunSet;
}
