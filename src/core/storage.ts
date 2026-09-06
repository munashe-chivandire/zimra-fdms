/**
 * Key-value persistence for the fiscal state. Three keys are ever written:
 * the day state, the pending-submit marker, and the highest global number
 * issued. Each `set` must be atomic for its key (write-then-rename on a
 * file system, a transaction in SQLite), because the whole crash-safety
 * argument rests on a reader never seeing half a value.
 */
export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }
  /** Snapshot for tests. */
  dump(): Record<string, string> {
    return Object.fromEntries(this.items);
  }
}

/**
 * Wrap a Storage so every write goes through `guard` first. Tests use it to
 * kill the process (throw) at a chosen write and check what the next start
 * sees.
 */
export function guardedStorage(inner: Storage, guard: (op: "set" | "delete", key: string) => void): Storage {
  return {
    get: (k) => inner.get(k),
    set: async (k, v) => {
      guard("set", k);
      await inner.set(k, v);
    },
    delete: async (k) => {
      guard("delete", k);
      await inner.delete(k);
    },
  };
}
