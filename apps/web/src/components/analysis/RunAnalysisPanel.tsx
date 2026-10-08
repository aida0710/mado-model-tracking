import type { RunAnalysisPanelProps } from '../charts/chartProps';

// Stub for this worktree (sweeps-web): run-analysis-web owns RunAnalysisPanel and its version
// wins at integration. It only marks where the panel is placed.
export function RunAnalysisPanel({ runSet }: RunAnalysisPanelProps) {
  return <div className="state-message" data-testid="run-analysis-panel-stub">{JSON.stringify(runSet)}</div>;
}
