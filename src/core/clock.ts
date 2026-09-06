/**
 * Where receipt dates come from. A POS terminal with a drifted clock gets
 * RCPT030 (Red) on every receipt and cannot close its day, so the core
 * learns the offset to FDMS from response Date headers and uses that.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ServerCorrectedClock implements Clock {
  private offset = 0;
  private samples = 0;

  constructor(private readonly base: Clock = systemClock) {}

  /** Milliseconds to add to the local clock to reach server time. */
  get offsetMs(): number {
    return this.offset;
  }

  /** How many server responses have contributed to the offset. */
  get confidence(): number {
    return this.samples;
  }

  /**
   * Feed a server Date header. HTTP dates resolve to whole seconds and the
   * response was sent about half a round trip ago, so both are corrected
   * for; the running average smooths per-request jitter.
   */
  learn(serverDate: Date, roundTripMs = 0): void {
    const estimate = serverDate.getTime() + roundTripMs / 2 - this.base.now().getTime();
    this.samples += 1;
    this.offset = this.samples === 1 ? estimate : this.offset + (estimate - this.offset) / Math.min(this.samples, 8);
  }

  now(): Date {
    return new Date(this.base.now().getTime() + this.offset);
  }
}
