/**
 * Append-only log for the offline queue.
 *
 * Records are appended once and never rewritten; a commit cursor marks how
 * many have been submitted. Enqueue is O(1), and a crash between append and
 * commit leaves either an extra record to resubmit (safe: the pending-submit
 * marker on the device catches the duplicate) or nothing, never a gap.
 */
export interface JournalEntry {
  /** Position of this record; pass `cursor + 1` to commit past it. */
  cursor: number;
  record: string;
}

export interface Journal {
  append(record: string): Promise<void>;
  /** Records at positions >= cursor, oldest first. */
  readFrom(cursor: number): Promise<JournalEntry[]>;
  /** Mark everything before `cursor` as submitted. */
  commit(cursor: number): Promise<void>;
  /** Position of the first unsubmitted record. */
  committed(): Promise<number>;
  /**
   * Rewrite one uncommitted record in place. Only snapshot-style stores
   * need this, to upgrade 0.3.x unsigned entries to signed ones on load;
   * append-only files never hold unsigned entries.
   */
  replace?(cursor: number, record: string): Promise<void>;
}

export class MemoryJournal implements Journal {
  private records: string[] = [];
  private cursor = 0;

  async append(record: string): Promise<void> {
    this.records.push(record);
  }
  async readFrom(cursor: number): Promise<JournalEntry[]> {
    return this.records.slice(cursor).map((record, i) => ({ cursor: cursor + i, record }));
  }
  async commit(cursor: number): Promise<void> {
    this.cursor = Math.max(this.cursor, cursor);
  }
  async committed(): Promise<number> {
    return this.cursor;
  }
}
