import type { Connection } from '../db/database.js';
import type { RunCompletionHandler, RunStatusChange } from './runCompletionService.js';
import type { ModelAutomationService } from './modelAutomationService.js';

// Resolves automation for versions registered while their training Run was still running.
// MLflow Runs can reopen (FINISHED → RUNNING → FINISHED), so this may run more than once per Run;
// only events still pending are touched, which keeps repeated calls from starting duplicates.
export class AutomationSourceRunHandler implements RunCompletionHandler {
  readonly name = 'automation-source-run';

  constructor(private readonly automation: ModelAutomationService) {}

  async handle(connection: Connection, change: RunStatusChange): Promise<void> {
    if (change.run.status === 'finished')
      await this.automation.releasePendingRegistrations(connection, change.run.id);
    else await this.automation.skipPendingRegistrations(connection, change.run.id);
  }
}
