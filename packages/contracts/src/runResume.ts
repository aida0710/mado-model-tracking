import type { Run, RunStatus } from './index.js';

export type RunResumeSource = 'native' | 'mlflow' | 'sync';

/**
 * One reopening of an ended Run. previousStatus/previousEndedAt describe the segment that ended
 * just before; maxStepAtResume is the largest metric step logged until then (null without metrics).
 */
export interface RunResumeEvent {
  id: string;
  runId: string;
  resumedAt: string;
  previousStatus: 'finished' | 'failed' | 'canceled';
  previousEndedAt: string | null;
  maxStepAtResume: number | null;
  source: RunResumeSource;
  actorUserId: string | null;
  reason: string | null;
}

export interface RunResumeRequest {
  reason?: string;
}

/** resumed=false means the Run was already running; nothing changed and event is null. */
export interface RunResumeResult {
  run: Run;
  resumed: boolean;
  event: RunResumeEvent | null;
  // Largest step per metric key so a client continues from the next step.
  lastSteps: Record<string, number>;
}

/**
 * A running period of a Run. The first segment starts at Run.startedAt and has firstStep=null;
 * each later one starts at a resume event. endedAt/endStatus are null while the segment runs.
 */
export interface RunSegment {
  startedAt: string;
  endedAt: string | null;
  endStatus: RunStatus | null;
  firstStep: number | null;
}

export interface RunResumeEventPage {
  items: RunResumeEvent[];
  segments: RunSegment[];
}

export const RUN_RESUME_REASON_MAX_LENGTH = 2000;
