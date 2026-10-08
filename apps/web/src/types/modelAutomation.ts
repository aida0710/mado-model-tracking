import type { ComputeTarget, ModelAutomationRule } from '@mmt/contracts';
import type { ExecutionCatalog } from './executionCatalog';

export type AutomationKind = ModelAutomationRule['kind'];
export interface AutomationCatalog {
  registry: ExecutionCatalog;
  targets: ComputeTarget[];
}
