import { transaction, type Database } from '../db/database.js';
import { listSchedulableSweepIds } from '../repositories/sweepRepository.js';
import { PollingLoop } from './pollingLoop.js';
import type { SweepController } from './sweepController.js';

// Early stopping compares metrics that workers send every few seconds to tens of seconds, so a
// shorter interval would mostly re-evaluate the same points.
export const SWEEP_TICK_INTERVAL_MS = 15000;

/** Periodically ticks running and paused sweeps: early stopping and recovery of missed launches. */
export class SweepScheduler {
  private readonly loop: PollingLoop;

  constructor(
    private readonly database: Database,
    private readonly controller: SweepController,
    intervalMs = SWEEP_TICK_INTERVAL_MS,
  ) {
    this.loop = new PollingLoop({
      intervalMs,
      run: () => this.tickAll(),
      failureEvent: 'sweep_scheduler_failed',
    });
  }

  start(): void {
    this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  /** One pass over every schedulable sweep. A failing sweep is logged and does not stop the others. */
  async tickAll(): Promise<void> {
    for (const sweepId of await listSchedulableSweepIds(this.database)) {
      try {
        await transaction(this.database, async (connection) => {
          // Another process or the completion handler is already advancing this sweep.
          if (!(await this.controller.tryLock(connection, sweepId))) return;
          await this.controller.tick(connection, { sweepId, applyEarlyStopping: true });
        });
      } catch {
        // Error details can include SQL text; the sweep id is enough to find it.
        console.error(JSON.stringify({ event: 'sweep_tick_failed', sweepId }));
      }
    }
  }
}
