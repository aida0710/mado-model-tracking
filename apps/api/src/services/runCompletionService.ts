import type { Run } from '@mmt/contracts';
import type { Connection } from '../db/database.js';

export interface RunCompletionHandler {
  // Stable name used in logs and to document the registration order in app.ts.
  readonly name: string;
  // Runs inside the transaction that moved the Run to a terminal status.
  handle(connection: Connection, run: Run): Promise<void>;
}

// Stub for wave 1: run-completion-hook moves terminal transitions onto complete()
// and defines failure isolation between handlers.
export class RunCompletionService {
  constructor(private readonly handlers: readonly RunCompletionHandler[]) {}

  async complete(connection: Connection, run: Run): Promise<void> {
    for (const handler of this.handlers) await handler.handle(connection, run);
  }
}
