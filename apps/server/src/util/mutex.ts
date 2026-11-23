/** FIFO async mutex: `run` executes callbacks one at a time, in call order. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private holders = 0;

  /** True while a callback is running or queued. */
  get locked(): boolean {
    return this.holders > 0;
  }

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.holders++;
    const result = this.tail.then(async () => {
      try {
        return await fn();
      } finally {
        this.holders--;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
