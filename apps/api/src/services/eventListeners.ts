import type { Connection } from '../db/database.js';

const LISTENER_SAVEPOINT = 'event_listener';

/**
 * Runs a listener inside the transaction of the event it listens to (a registration, a saved
 * checkpoint). A failing listener is rolled back to a savepoint and logged, so the event itself
 * is still stored, as RunCompletionService does for its handlers.
 */
export async function notifyListener(
  connection: Connection,
  notification: { listener: string; subjectId: string; notify: () => Promise<void> },
): Promise<void> {
  await connection.query(`SAVEPOINT ${LISTENER_SAVEPOINT}`);
  try {
    await notification.notify();
  } catch (error) {
    await connection.query(`ROLLBACK TO SAVEPOINT ${LISTENER_SAVEPOINT}`);
    console.error(
      JSON.stringify({
        event: 'event_listener_failed',
        listener: notification.listener,
        subjectId: notification.subjectId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  await connection.query(`RELEASE SAVEPOINT ${LISTENER_SAVEPOINT}`);
}
