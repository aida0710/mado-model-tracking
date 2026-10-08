import type { RunSet } from '@mmt/contracts';

// Stub for this worktree only: metrics-chart-core-web owns this file in wave 5 and its version
// (with MetricsChartProps and the other panel props) replaces this one at integration.
export interface RunAnalysisPanelProps {
  projectId: string;
  runSet: RunSet;
}
