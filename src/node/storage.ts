/**
 * File-backed Storage and Journal for Node.
 *
 * FileStorage keeps one JSON file per key in a directory, written to a temp
 * file and renamed so a crash mid-write leaves the old value, never a torn
 * one. The key names match what the CLI profile has always written
 * (`day-state.json`, `last-receipt-global-no.json`), so a profile directory
 * is a valid FileStorage.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "../core/storage.js";
import type { Journal, JournalEntry } from "../core/journal.js";

const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class FileStorage implements Storage {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error(`Storage key "${key}" is not a safe file name`);
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<string | null> {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  }

  async set(key: string, value: string): Promise<void> {
    atomicWrite(this.path(key), value);
  }

  async delete(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
  }
}

/**
 * JSONL journal: one record per line in `<name>.jsonl`, and the commit
 * cursor in `<name>.cursor`. Append is a single appendFileSync; the file is
 * never rewritten. A record is one line, so records must not contain
 * newlines (JSON.stringify output never does).
 */
export class FileJournal implements Journal {
  private readonly logPath: string;
  private readonly cursorPath: string;

  constructor(dir: string, name = "receipt-journal") {
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, `${name}.jsonl`);
    this.cursorPath = join(dir, `${name}.cursor`);
  }

  async append(record: string): Promise<void> {
    if (record.includes("\n")) throw new Error("Journal records must be single-line");
    appendFileSync(this.logPath, record + "\n");
  }

  async readFrom(cursor: number): Promise<JournalEntry[]> {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, "utf-8").split("\n");
    // A crash mid-append can leave a partial last line; it has no newline,
    // so it is the last element and is dropped when it fails to parse.
    const out: JournalEntry[] = [];
    for (let i = cursor; i < lines.length; i++) {
      const record = lines[i]!;
      if (record === "") continue;
      try {
        JSON.parse(record);
      } catch {
        if (i === lines.length - 1) break;
        throw new Error(`Corrupt journal record at line ${i + 1} of ${this.logPath}`);
      }
      out.push({ cursor: i, record });
    }
    return out;
  }

  async commit(cursor: number): Promise<void> {
    if (cursor > (await this.committed())) atomicWrite(this.cursorPath, String(cursor));
  }

  async committed(): Promise<number> {
    return existsSync(this.cursorPath) ? Number(readFileSync(this.cursorPath, "utf-8")) || 0 : 0;
  }

  /**
   * Drop committed records so the file does not grow forever. Rewrites the
   * file once; call it from housekeeping, not per receipt.
   */
  async compact(): Promise<void> {
    const cursor = await this.committed();
    if (cursor === 0 || !existsSync(this.logPath)) return;
    const lines = readFileSync(this.logPath, "utf-8").split("\n");
    const remaining = lines.slice(cursor).join("\n");
    atomicWrite(this.logPath, remaining);
    atomicWrite(this.cursorPath, "0");
  }
}
