/**
 * Offline receipt queue. FDMS allows receipts to be issued while offline and
 * submitted retroactively (72-hour grace window) — receipts are signed and
 * numbered locally at sale time, then flushed in order when connectivity
 * returns. Order matters: the hash chain and counters are sequential.
 */
import type { FiscalDevice, ReceiptInput, SubmittedReceipt } from "./device.js";

export interface QueueStorage {
  load(): Promise<ReceiptInput[]>;
  save(pending: ReceiptInput[]): Promise<void>;
}

export class MemoryQueueStorage implements QueueStorage {
  private items: ReceiptInput[] = [];
  async load(): Promise<ReceiptInput[]> {
    return [...this.items];
  }
  async save(pending: ReceiptInput[]): Promise<void> {
    this.items = [...pending];
  }
}

export interface FlushResult {
  submitted: SubmittedReceipt[];
  /** Still pending after this flush (network failed again, or a rejection). */
  remaining: number;
  /** Set when flushing stopped on an error. */
  error?: unknown;
}

export class OfflineReceiptQueue {
  private pending: ReceiptInput[] = [];
  private loaded = false;

  constructor(
    private readonly device: FiscalDevice,
    private readonly storage: QueueStorage = new MemoryQueueStorage(),
  ) {}

  /** Number of receipts waiting for submission. */
  get size(): number {
    return this.pending.length;
  }

  /** Queue a receipt for later submission (e.g. while offline). */
  async enqueue(input: ReceiptInput): Promise<void> {
    await this.ensureLoaded();
    this.pending.push(input);
    await this.storage.save(this.pending);
  }

  /**
   * Try to submit a receipt immediately; on network failure, queue it.
   * Always flushes older queued receipts first to preserve ordering.
   */
  async submitOrEnqueue(
    input: ReceiptInput,
  ): Promise<SubmittedReceipt | undefined> {
    await this.ensureLoaded();
    if (this.pending.length > 0) {
      const flush = await this.flush();
      if (flush.remaining > 0) {
        await this.enqueue(input);
        return undefined;
      }
    }
    try {
      return await this.device.submitReceipt(input);
    } catch (err) {
      if (isNetworkError(err)) {
        await this.enqueue(input);
        return undefined;
      }
      throw err;
    }
  }

  /** Submit queued receipts in FIFO order, stopping at the first failure. */
  async flush(): Promise<FlushResult> {
    await this.ensureLoaded();
    const submitted: SubmittedReceipt[] = [];
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      try {
        submitted.push(await this.device.submitReceipt(next));
        this.pending.shift();
        await this.storage.save(this.pending);
      } catch (error) {
        return { submitted, remaining: this.pending.length, error };
      }
    }
    return { submitted, remaining: 0 };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.pending = await this.storage.load();
      this.loaded = true;
    }
  }
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    /timed out/i.test(err.message)
  );
}
