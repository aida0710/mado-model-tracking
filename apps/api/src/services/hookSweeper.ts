import { HOOK_PENDING_MAX_AGE_HOURS } from '@mmt/contracts';
import { transaction, type Database } from '../db/database.js';
import type { HookDispatcher } from './hookDispatcher.js';
import type { JobArrayCompletionHandler } from './jobArrayCompletionHandler.js';
import { PollingLoop } from './pollingLoop.js';

// Pending starts expire after days, and an idle array is a rare leftover; minutes are enough.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;
// Shared by every API process on the same schema so only one of them sweeps at a time.
const SWEEPER_LOCK_NAME = 'hook_sweeper';

/**
 * Upkeep the hooks cannot do at an event: pending starts whose Run never ended are skipped
 * (source_run_timeout), and arrays whose last member ended without a Job transition (a Run
 * ended by PATCH while its Job kept running) are finished.
 */
export class HookSweeper {
  private readonly loop: PollingLoop;

  constructor(
    private readonly database: Database,
    private readonly hooks: HookDispatcher,
    private readonly arrays: JobArrayCompletionHandler,
    private readonly maxAgeHours = HOOK_PENDING_MAX_AGE_HOURS,
  ) {
    this.loop = new PollingLoop({
      intervalMs: SWEEP_INTERVAL_MS,
      run: () => this.sweep(),
      failureEvent: 'hook_sweep_failed',
    });
  }

  start(): void {
    this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  /** Returns how many executions expired and arrays finished; 0 when another process sweeps. */
  async sweep(): Promise<number> {
    return transaction(this.database, async (connection) => {
      const lock = await connection.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1||':'||current_schema(),0)) AS acquired",
        [SWEEPER_LOCK_NAME],
      );
      if (!lock.rows[0]?.acquired) return 0;
      let changed = await this.hooks.expirePending(connection, {
        maxAgeHours: this.maxAgeHours,
        limit: SWEEP_BATCH_SIZE,
      });
      for (const groupId of await this.arrays.listIdleGroups(connection, SWEEP_BATCH_SIZE))
        if (await this.arrays.finishIfDone(connection, groupId)) changed += 1;
      return changed;
    });
  }
}
