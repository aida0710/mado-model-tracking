import type { Run, RunStatus } from '@mmt/contracts';
import type { Connection } from '../db/database.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import { enqueueRunEvent } from './outboxEvents.js';

export interface RunStatusChange {
  readonly previousStatus: RunStatus;
  // The Run as stored after the change, including its new status.
  readonly run: Run;
}

export interface RunCompletionHandler {
  // Stable name used in logs and to document the registration order in app.ts.
  readonly name: string;
  // Runs inside the transaction that moved the Run to a terminal status, once per transition.
  // A thrown error is rolled back to a savepoint and logged; handlers that must keep a failure
  // record write it to their own table instead of throwing.
  handle(connection: Connection, change: RunStatusChange): Promise<void>;
}

const HANDLER_SAVEPOINT = 'run_completion_handler';

export class RunCompletionService {
  constructor(private readonly handlers: readonly RunCompletionHandler[]) {}

  // Every Run status change goes through here. Plugin outbox events stay per change (including
  // run.started), while terminal handlers only run on the non-terminal → terminal transition.
  async recordStatusChange(connection: Connection, change: RunStatusChange): Promise<void> {
    await enqueueRunEvent(connection, change.run);
    if (isTerminalStatus(change.previousStatus) || !isTerminalStatus(change.run.status)) return;
    for (const handler of this.handlers) await this.runHandler(connection, { handler, change });
  }

  // A handler bug must not block worker completion: the Run/Job would stay non-terminal and
  // gpu_reservations would never be released.
  private async runHandler(
    connection: Connection,
    invocation: { handler: RunCompletionHandler; change: RunStatusChange },
  ): Promise<void> {
    const { handler, change } = invocation;
    await connection.query(`SAVEPOINT ${HANDLER_SAVEPOINT}`);
    try {
      await handler.handle(connection, change);
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${HANDLER_SAVEPOINT}`);
      console.error(
        JSON.stringify({
          event: 'run_completion_handler_failed',
          handler: handler.name,
          runId: change.run.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await connection.query(`RELEASE SAVEPOINT ${HANDLER_SAVEPOINT}`);
  }
}
