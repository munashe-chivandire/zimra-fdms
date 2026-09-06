/**
 * Offline receipt queue. FDMS allows receipts to be issued while offline and
 * submitted retroactively (72-hour grace window). Receipts are numbered,
 * hash-chained and signed at sale time, appended to a journal, and flushed
 * in order when connectivity returns. Order matters: the chain is fixed the
 * moment a receipt is signed.
 */
import type { FiscalDevice, PreparedReceipt, ReceiptInput, SubmittedReceipt } from "./device.js";
import { MemoryJournal, type Journal } from "./journal.js";
import { isNetworkError } from "./transport.js";

/**
 * 0.3.x storage: a whole-array snapshot. Still accepted; it is wrapped in a
 * Journal. Snapshots written by 0.3.x hold unsigned ReceiptInputs, which
 * are signed at flush time as they always were.
 */
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

/** Journal over a legacy QueueStorage. Committed records are dropped from the snapshot. */
export function journalFromQueueStorage(storage: QueueStorage): Journal {
  let records: string[] | undefined;
  let cursor = 0;
  const load = async () => {
    if (!records) records = (await storage.load()).map((r) => JSON.stringify(r));
    return records;
  };
  return {
    async append(record) {
      (await load()).push(record);
      await storage.save(records!.slice(cursor).map((r) => JSON.parse(r)));
    },
    async readFrom(from) {
      return (await load()).slice(from).map((record, i) => ({ cursor: from + i, record }));
    },
    async commit(to) {
      await load();
      cursor = Math.max(cursor, to);
      await storage.save(records!.slice(cursor).map((r) => JSON.parse(r)));
    },
    async committed() {
      return cursor;
    },
    async replace(at, record) {
      const all = await load();
      all[at] = record;
      await storage.save(all.slice(cursor).map((r) => JSON.parse(r)));
    },
  };
}

export interface FlushResult {
  submitted: SubmittedReceipt[];
  /** Still pending after this flush (network failed again, or a rejection). */
  remaining: number;
  /** Set when flushing stopped on an error. */
  error?: unknown;
}

type Pending = { cursor: number; item: PreparedReceipt | ReceiptInput };

const isPrepared = (item: PreparedReceipt | ReceiptInput): item is PreparedReceipt =>
  "receipt" in item && "stateAfter" in item;

export class OfflineReceiptQueue {
  private readonly journal: Journal;
  private pending: Pending[] = [];
  private loaded = false;

  constructor(
    private readonly device: FiscalDevice,
    journal: Journal | QueueStorage = new MemoryJournal(),
  ) {
    this.journal = "load" in journal ? journalFromQueueStorage(journal) : journal;
  }

  /** Number of receipts waiting for submission. */
  get size(): number {
    return this.pending.length;
  }

  /**
   * Milliseconds since the oldest pending receipt was issued, or undefined
   * when nothing is pending. Warn well before FDMS's 72-hour window.
   */
  get oldestPendingAgeMs(): number | undefined {
    const first = this.pending[0]?.item;
    if (!first || !isPrepared(first)) return undefined;
    return Date.now() - new Date(first.date).getTime();
  }

  /**
   * Sign a receipt now and journal it for later submission. The device's
   * counters advance immediately so the next sale chains after this one.
   */
  async enqueue(input: ReceiptInput): Promise<PreparedReceipt> {
    await this.ensureLoaded();
    if (this.pending.some((p) => !isPrepared(p.item))) {
      throw new Error(
        "The queue holds unsigned receipts from a 0.3.x snapshot that this Journal cannot upgrade; flush() them before enqueueing new ones.",
      );
    }
    const prepared = await this.device.signReceipt(input);
    await this.take(prepared);
    return prepared;
  }

  /**
   * Try to submit a receipt immediately; on network failure, journal it.
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
    const prepared = await this.device.signReceipt(input);
    try {
      return await this.device.submitPrepared(prepared);
    } catch (err) {
      if (isNetworkError(err)) {
        // The device wrote a pending marker for this receipt; the journal
        // owns it from here, so the marker is dropped.
        await this.device.discardPending();
        await this.take(prepared);
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Submit queued receipts in FIFO order, stopping at the first failure.
   * A network error keeps the receipt for next time; any other error is
   * returned in `error` and nothing after it is attempted.
   */
  async flush(): Promise<FlushResult> {
    await this.ensureLoaded();
    const submitted: SubmittedReceipt[] = [];
    while (this.pending.length > 0) {
      const { cursor, item } = this.pending[0]!;
      try {
        submitted.push(await this.submitOne(item));
        await this.journal.commit(cursor + 1);
        this.pending.shift();
      } catch (error) {
        return { submitted, remaining: this.pending.length, error };
      }
    }
    return { submitted, remaining: 0 };
  }

  private async submitOne(item: PreparedReceipt | ReceiptInput): Promise<SubmittedReceipt> {
    if (!isPrepared(item)) return this.device.submitReceipt(item);
    // A previous flush may have died after writing the marker for this very
    // receipt; reconcile() settles it without a duplicate submit.
    const marker = await this.device.pendingReceipt();
    if (marker && marker.receipt.receiptGlobalNo === item.receipt.receiptGlobalNo) {
      const r = await this.device.reconcile();
      if (r.action === "rejected") throw r.error;
      const response = r.action === "resubmitted" ? r.response : ({} as SubmittedReceipt["response"]);
      return { receipt: item.receipt, response, qrData: this.device.qrData(item) };
    }
    return this.device.submitPrepared(item);
  }

  private async take(prepared: PreparedReceipt): Promise<void> {
    // Append first. If the process dies before applyPrepared, ensureLoaded
    // on the next start sees a journal entry ahead of the device state and
    // catches the state up, so the number is neither reused nor skipped.
    const cursor = (await this.journal.committed()) + this.pending.length;
    await this.journal.append(JSON.stringify(prepared));
    await this.device.applyPrepared(prepared);
    this.pending.push({ cursor, item: prepared });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const entries = await this.journal.readFrom(await this.journal.committed());
    this.pending = entries.map((e) => ({ cursor: e.cursor, record: e.record })).map((e) => ({
      cursor: e.cursor,
      item: JSON.parse(e.record) as PreparedReceipt | ReceiptInput,
    }));
    this.loaded = true;

    const last = this.pending[this.pending.length - 1]?.item;
    const state = this.device.getState();
    if (last && isPrepared(last) && state && last.stateAfter.receiptGlobalNo > state.receiptGlobalNo) {
      this.device.restoreState(last.stateAfter);
    }

    // 0.3.x snapshots hold unsigned inputs. Sign them now, in order, so
    // anything enqueued afterwards chains behind them.
    if (this.journal.replace && state) {
      for (const p of this.pending) {
        if (isPrepared(p.item)) continue;
        const prepared = await this.device.signReceipt(p.item);
        await this.journal.replace(p.cursor, JSON.stringify(prepared));
        await this.device.applyPrepared(prepared);
        p.item = prepared;
      }
    }
  }
}
