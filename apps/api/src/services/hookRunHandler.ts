import type { Connection } from '../db/database.js';
import type { HookDispatcher } from './hookDispatcher.js';
import type { RunCompletionHandler, RunStatusChange } from './runCompletionService.js';

/** Starts run_finished hooks and what waited for the Run to end (pending executions). */
export class HookRunHandler implements RunCompletionHandler {
  readonly name = 'hooks';

  constructor(private readonly hooks: HookDispatcher) {}

  async handle(connection: Connection, change: RunStatusChange): Promise<void> {
    await this.hooks.onRunEnded(connection, change.run);
  }
}
