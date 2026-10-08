import type { ComputeTarget, ModelAutomationRule } from '@mmt/contracts';
import type { ExecutionCatalog } from './executionCatalog';

export type AutomationKind = ModelAutomationRule['kind'];
export type AutomationTrigger = ModelAutomationRule['trigger'];
export interface AutomationCatalog {
  registry: ExecutionCatalog;
  targets: ComputeTarget[];
  // Rules of the same Project, offered as the upstream stage of a chained rule.
  rules: ModelAutomationRule[];
}
