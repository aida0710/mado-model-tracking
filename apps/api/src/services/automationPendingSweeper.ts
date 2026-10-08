import { transaction, type Database } from '../db/database.js';
import type { ModelAutomationService } from './modelAutomationService.js';

// Longer than any expected training Run, yet short enough that pending automation left behind by
// Runs that never report an end (unknown worker state, MLflow Runs without end_run) is cleared weekly.
export const AUTOMATION_PENDING_MAX_AGE_HOURS = 168;
// Expiry is measured in days, so a coarse interval keeps the query load negligible.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;
// Shared by every API process on the same schema so only one of them sweeps at a time.
const SWEEPER_LOCK_NAME = 'automation_pending_sweeper';

export class AutomationPendingSweeper {
  private isStopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<number> | undefined;

  constructor(
    private readonly database: Database,
    private readonly automation: ModelAutomationService,
    private readonly maxAgeHours = AUTOMATION_PENDING_MAX_AGE_HOURS,
  ) {}

  start(): void {
    if (!this.isStopped) return;
    this.isStopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active?.catch(() => undefined);
  }

  // Returns the number of expired events; 0 also when another process holds the sweep lock.
  async sweep(): Promise<number> {
    let expired = 0;
    for (;;) {
      const batch = await this.sweepBatch();
      expired += batch;
      if (batch < SWEEP_BATCH_SIZE) return expired;
    }
  }

  private async sweepBatch(): Promise<number> {
    return transaction(this.database, async (connection) => {
      const lock = await connection.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1||':'||current_schema(),0)) AS acquired",
        [SWEEPER_LOCK_NAME],
      );
      if (!lock.rows[0]?.acquired) return 0;
      return this.automation.expirePendingRegistrations(connection, {
        maxAgeHours: this.maxAgeHours,
        limit: SWEEP_BATCH_SIZE,
      });
    });
  }

  private schedule(): void {
    if (this.isStopped) return;
    this.timer = setTimeout(() => {
      this.active = this.sweep();
      void this.active
        .catch(() => console.error(JSON.stringify({ event: 'automation_pending_sweep_failed' })))
        .finally(() => {
          this.active = undefined;
          this.schedule();
        });
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }
}
