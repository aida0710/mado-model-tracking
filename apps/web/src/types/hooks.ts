import type { ComputeTarget } from '@mmt/contracts';
import type { ExecutionCatalog } from './executionCatalog';

/** What the hook form offers: the Project's registry and the compute targets. */
export interface HookCatalog {
  registry: ExecutionCatalog;
  targets: ComputeTarget[];
}
