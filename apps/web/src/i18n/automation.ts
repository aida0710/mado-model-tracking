import type { ModelAutomationExecution } from '@mmt/contracts';
import { text } from './catalog';

export const automationOutcomeLabels: Record<ModelAutomationExecution['status'], string> = {
  queued: text.automationQueued,
  failed: text.automationFailed,
  skipped: text.automationSkipped,
};
