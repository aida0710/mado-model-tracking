import type { Connection } from '../db/database.js';
import { findTrialByRunId } from '../repositories/sweepRepository.js';
import type { RunCompletionHandler, RunStatusChange } from './runCompletionService.js';
import type { SweepController } from './sweepController.js';

/**
 * Records a sweep trial's outcome when its Run ends and launches the next trial into the freed
 * slot in the same transaction. Runs that are not sweep trials are ignored. Repeated calls for the
 * same Run recompute the objective and never launch beyond parallelism or max_trials.
 */
export class SweepTrialCompletionHandler implements RunCompletionHandler {
  readonly name = 'sweep_trial';

  constructor(private readonly controller: SweepController) {}

  async handle(connection: Connection, change: RunStatusChange): Promise<void> {
    const trial = await findTrialByRunId(connection, change.run.id);
    if (!trial) return;
    await this.controller.recordTrialEnd(connection, trial);
  }
}
