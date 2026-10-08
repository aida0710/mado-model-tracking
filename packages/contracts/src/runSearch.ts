import type { Run, RunKind, RunStatus } from './index.js';

/**
 * Server-side Run search over the whole history. `filter` and `orderBy` use MLflow search syntax
 * (`metrics.loss < 0.1 AND params.lr = '0.01'`, `metrics.loss ASC`). Without `orderBy` the page is
 * ordered by creation time, newest first, and its cursor stays stable while new Runs arrive.
 * Limits (docs/api-contract.md): filter 2000 characters, orderBy 5 entries, limit 1-500 (default 100).
 */
export interface RunSearchRequest {
  experimentIds?: string[];
  filter?: string;
  orderBy?: string[];
  kinds?: RunKind[];
  statuses?: RunStatus[];
  modelVersionIds?: string[];
  inputDatasetVersionIds?: string[];
  parentRunId?: string;
  /** Case-insensitive substring of the Run name. */
  name?: string;
  limit?: number;
  /** `nextCursor` of the previous page. It is rejected if any other condition changed. */
  cursor?: string;
}
/** Items carry the polling summary of a Run, without `executionSnapshot`. */
export interface RunSearchPage {
  items: Run[];
  nextCursor: string | null;
}
