import type { JobStatus, JsonObject, RunStatus } from './index.js';

export interface ModelAutomationRule {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  modelFamilies: string[];
  kind: 'inference' | 'evaluation';
  experimentId: string;
  codeVersionId: string;
  targetId: string;
  gpuIds: string[];
  inputDatasetVersionIds: string[];
  parameters: JsonObject;
  tags: Record<string, string>;
  maxAttempts: number;
  createdBy: string;
  createdAt: string;
}

export interface ModelAutomationExecution {
  id: string;
  projectId: string;
  ruleId: string;
  modelVersionId: string;
  runId: string | null;
  jobId: string | null;
  status: 'queued' | 'failed' | 'skipped';
  runStatus: RunStatus | null;
  jobStatus: JobStatus | null;
  error: string | null;
  createdAt: string;
}
