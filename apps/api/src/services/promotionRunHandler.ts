import type { Connection } from '../db/database.js';
import type { PromotionService } from './promotionService.js';
import type { RunCompletionHandler, RunStatusChange } from './runCompletionService.js';

// Judges a finished evaluation Run against the promotion policies of the rule that produced it,
// inside the terminal transition (decisions.md: judged in the same transaction as the Run's end).
// Its place in the wave-wide handler order is after automation chaining and before automatic retry.
export class PromotionRunHandler implements RunCompletionHandler {
  readonly name = 'promotion';

  constructor(private readonly promotion: PromotionService) {}

  async handle(connection: Connection, change: RunStatusChange): Promise<void> {
    await this.promotion.processFinishedRun(connection, change.run);
  }
}
