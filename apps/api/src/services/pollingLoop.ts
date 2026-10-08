/**
 * Runs one background task repeatedly with a pause between runs, never overlapping itself.
 * stop() waits for the running task, so server shutdown does not cut a database write short.
 */
export class PollingLoop {
  private isStopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<unknown> | undefined;

  constructor(
    private readonly options: {
      intervalMs: number;
      run: () => Promise<unknown>;
      /** Logged without error details, which can include storage locations. */
      failureEvent: string;
    },
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

  private schedule(): void {
    if (this.isStopped) return;
    this.timer = setTimeout(() => {
      this.active = this.options.run();
      void this.active
        .catch(() => console.error(JSON.stringify({ event: this.options.failureEvent })))
        .finally(() => {
          this.active = undefined;
          this.schedule();
        });
    }, this.options.intervalMs);
    this.timer.unref();
  }
}
