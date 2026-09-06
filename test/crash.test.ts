/**
 * Crash safety: a process may die at any storage write or any network call.
 * Every test kills the device at one such point, builds a fresh device on
 * the same storage (a restart), reconciles, and checks that FDMS ends up
 * with each global number exactly once.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FiscalDevice, PendingSubmitError, type ReceiptInput } from "../src/core/device.js";
import { MemoryStorage, guardedStorage, type Storage } from "../src/core/storage.js";
import { MemoryJournal } from "../src/core/journal.js";
import { OfflineReceiptQueue, MemoryQueueStorage } from "../src/core/queue.js";
import { TransportError, type Transport } from "../src/core/transport.js";
import { FdmsApiError } from "../src/core/types.js";
import { cents, amountToCents, moneyFromJsonNumber, formatCents } from "../src/core/money.js";
import { generatePemSigner } from "../src/node/pem-signer.js";
import { FileStorage, FileJournal } from "../src/node/storage.js";

const DEVICE = { deviceId: 7, serialNumber: "S", modelName: "M", modelVersion: "1" };
const SALE: ReceiptInput = {
  currency: "USD",
  invoiceNo: "1",
  lines: [{ name: "a", price: cents("11.50"), quantity: 2, taxId: 3, taxPercent: 15 }],
  payments: [{ moneyType: "Cash", amount: 23 }],
};

class Crash extends Error {}

/**
 * Scripted FDMS that records every global number it accepts and can drop
 * the connection after processing a request (the answer never arrives).
 */
function fakeFdms() {
  const accepted: number[] = [];
  let status = "FiscalDayClosed";
  let lastGlobal = 10;
  const faults = { dropAfterSubmit: false, rejectSubmit: false };
  const transport: Transport = {
    request: async (req) => {
      const path = new URL(req.url).pathname.split("/").pop()!;
      const body = req.body ? JSON.parse(req.body) : undefined;
      const reply = (obj: unknown) => ({ status: 200, headers: { date: new Date().toUTCString() }, text: JSON.stringify(obj) });
      switch (path) {
        case "GetStatus":
          return reply({ fiscalDayStatus: status, lastReceiptGlobalNo: lastGlobal });
        case "OpenDay":
          status = "FiscalDayOpened";
          return reply({ fiscalDayNo: 3, operationID: "op" });
        case "SubmitReceipt": {
          if (faults.rejectSubmit) {
            return { status: 422, headers: {}, text: JSON.stringify({ errorCode: "FDC02", detail: "day not open" }) };
          }
          const g = body.receipt.receiptGlobalNo as number;
          if (g !== lastGlobal + 1) {
            return reply({ receiptID: g, validationErrors: [{ validationErrorCode: "RCPT012", validationErrorColor: "Red" }], operationID: "op" });
          }
          accepted.push(g);
          lastGlobal = g;
          if (faults.dropAfterSubmit) {
            faults.dropAfterSubmit = false;
            throw new TransportError("connection reset");
          }
          return reply({ receiptID: g, validationErrors: [], operationID: "op" });
        }
        case "CloseDay":
          status = "FiscalDayClosed";
          return reply({ operationID: "op" });
        default:
          return { status: 404, headers: {}, text: "" };
      }
    },
  };
  return { transport, accepted, faults, get lastGlobal() { return lastGlobal; } };
}

async function device(storage: Storage, transport: Transport) {
  const { signer } = await generatePemSigner();
  return new FiscalDevice(DEVICE, { signer, transport, storage });
}

describe("money", () => {
  it("parses decimal strings exactly and refuses floats", () => {
    assert.equal(cents("11.50").cents, 1150);
    assert.equal(cents("0.1").cents, 10);
    assert.equal(cents("-3").cents, -300);
    assert.throws(() => cents("1.234"));
    assert.equal(amountToCents(115, "x"), 11500);
    assert.equal(amountToCents(cents("0.30"), "x"), 30);
    assert.throws(() => amountToCents(0.1 + 0.2, "lines[0].price"), /fractional/);
    assert.equal(formatCents(11550), "115.50");
    assert.equal(formatCents(-5), "-0.05");
  });
  it("converts JSON numbers with two places and refuses finer ones", () => {
    assert.deepEqual(moneyFromJsonNumber(2.5, "x"), { cents: 250 });
    assert.equal(moneyFromJsonNumber(5, "x"), 5);
    assert.throws(() => moneyFromJsonNumber(2.505, "x"));
  });
  it("keeps the receipt arithmetic in whole cents", async () => {
    const fdms = fakeFdms();
    const fd = await device(new MemoryStorage(), fdms.transport);
    await fd.openDay();
    const { receipt } = await fd.submitReceipt({
      currency: "USD",
      invoiceNo: "1",
      lines: [
        { name: "a", price: cents("0.10"), quantity: 3, taxId: 3, taxPercent: 15 },
        { name: "b", price: cents("0.20"), quantity: 1, taxId: 3, taxPercent: 15 },
      ],
      payments: [{ moneyType: "Cash", amount: cents("0.50") }],
    });
    assert.equal(receipt.receiptTotal, 0.5);
    assert.equal(receipt.receiptTaxes[0]!.salesAmountWithTax, 0.5);
    // 0.30 -> tax 0.04 (3.913 cents rounds to 4), 0.20 -> 0.03 (2.609 -> 3)
    assert.equal(receipt.receiptTaxes[0]!.taxAmount, 0.07);
  });
});

describe("pending-submit marker", () => {
  it("is written before the request and removed after commit", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const seen: string[] = [];
    const watched = guardedStorage(storage, (op, key) => seen.push(`${op}:${key}`));
    const fd = await device(watched, fdms.transport);
    await fd.openDay();
    await fd.submitReceipt(SALE);
    assert.deepEqual(seen, [
      "set:day-state", // openDay
      "set:last-receipt-global-no",
      "set:pending-submit",
      "set:day-state",
      "set:last-receipt-global-no",
      "delete:pending-submit",
    ]);
    assert.equal(await fd.pendingReceipt(), undefined);
  });

  it("refuses new receipts and closes while a submit is unresolved", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const fd = await device(storage, fdms.transport);
    await fd.openDay();
    fdms.faults.dropAfterSubmit = true;
    await assert.rejects(fd.submitReceipt(SALE), TransportError);
    await assert.rejects(fd.submitReceipt(SALE), PendingSubmitError);
    await assert.rejects(fd.closeDay(), PendingSubmitError);
  });

  it("server rejection clears the marker and leaves counters untouched", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const fd = await device(storage, fdms.transport);
    await fd.openDay();
    fdms.faults.rejectSubmit = true;
    await assert.rejects(fd.submitReceipt(SALE), FdmsApiError);
    assert.equal(await fd.pendingReceipt(), undefined);
    assert.equal(fd.getState()!.receiptGlobalNo, 10);
    fdms.faults.rejectSubmit = false;
    const { receipt } = await fd.submitReceipt(SALE);
    assert.equal(receipt.receiptGlobalNo, 11);
  });
});

describe("reconcile after a crash", () => {
  const scenarios: { name: string; killAt: string; expectAction: string }[] = [
    { name: "before the marker is written", killAt: "set:pending-submit", expectAction: "none" },
    { name: "after the marker, before the request", killAt: "request", expectAction: "resubmitted" },
    { name: "after FDMS accepted, before state commit", killAt: "set:day-state", expectAction: "confirmed" },
    { name: "after state commit, before marker delete", killAt: "delete:pending-submit", expectAction: "confirmed" },
  ];

  for (const sc of scenarios) {
    it(`killed ${sc.name}`, async () => {
      const storage = new MemoryStorage();
      const fdms = fakeFdms();
      let armed = false;
      const killing = guardedStorage(storage, (op, key) => {
        if (armed && `${op}:${key}` === sc.killAt) throw new Crash(sc.killAt);
      });
      const killingTransport: Transport = {
        request: async (req) => {
          if (armed && sc.killAt === "request" && req.url.endsWith("SubmitReceipt")) throw new Crash("request");
          return fdms.transport.request(req);
        },
      };

      const fd1 = await device(killing, killingTransport);
      await fd1.openDay();
      await fd1.submitReceipt({ ...SALE, invoiceNo: "warm-up" });
      armed = true;
      await assert.rejects(fd1.submitReceipt(SALE), Crash);
      armed = false;

      // Restart on the same storage.
      const fd2 = await device(storage, fdms.transport);
      const result = await fd2.reconcile();
      assert.equal(result.action, sc.expectAction, JSON.stringify(result));

      const { receipt } = await fd2.submitReceipt({ ...SALE, invoiceNo: "after" });
      const expectedNext = sc.expectAction === "none" ? 12 : 13;
      assert.equal(receipt.receiptGlobalNo, expectedNext);
      assert.deepEqual(fdms.accepted, sc.expectAction === "none" ? [11, 12] : [11, 12, 13]);
      assert.equal(new Set(fdms.accepted).size, fdms.accepted.length, "no duplicates");
      assert.equal(fd2.getState()!.previousReceiptHash, receipt.receiptDeviceSignature.hash);
    });
  }

  it("resubmits the identical signed receipt when the connection dropped", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const fd = await device(storage, fdms.transport);
    await fd.openDay();
    // FDMS processed the receipt, then the socket died: the answer is lost.
    fdms.faults.dropAfterSubmit = true;
    await assert.rejects(fd.submitReceipt(SALE), TransportError);
    const pending = (await fd.pendingReceipt())!;
    assert.equal(pending.receipt.receiptGlobalNo, 11);

    const r = await fd.reconcile();
    assert.equal(r.action, "confirmed");
    assert.deepEqual(fdms.accepted, [11]);
    assert.equal(fd.getState()!.receiptGlobalNo, 11);
  });

  it("loads persisted day state on a cold start", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const fd1 = await device(storage, fdms.transport);
    await fd1.openDay();
    await fd1.submitReceipt(SALE);
    const fd2 = await device(storage, fdms.transport);
    assert.equal(fd2.getState(), undefined);
    await fd2.reconcile();
    assert.deepEqual(fd2.getState(), fd1.getState());
  });

  it("openDay uses the highest number ever issued, not the server's under-report", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const fd = await device(storage, fdms.transport);
    await fd.openDay();
    await fd.submitReceipt(SALE);
    await fd.closeDay();
    await storage.set("last-receipt-global-no", JSON.stringify({ deviceId: 7, lastReceiptGlobalNo: 40 }));
    await fd.openDay();
    assert.equal(fd.getState()!.receiptGlobalNo, 40);
  });
});

describe("offline queue with a journal", () => {
  const offline: Transport = {
    request: async (req) => {
      if (req.url.endsWith("SubmitReceipt")) throw new TransportError("offline");
      return fakeFdms().transport.request(req);
    },
  };

  it("signs at sale time and flushes in order", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const { signer } = await generatePemSigner();
    let online = false;
    const flaky: Transport = {
      request: (req) =>
        !online && req.url.endsWith("SubmitReceipt") ? Promise.reject(new TransportError("offline")) : fdms.transport.request(req),
    };
    const fd = new FiscalDevice(DEVICE, { signer, transport: flaky, storage });
    await fd.openDay();
    const q = new OfflineReceiptQueue(fd, new MemoryJournal());

    const a = await q.submitOrEnqueue({ ...SALE, invoiceNo: "a" });
    const b = await q.submitOrEnqueue({ ...SALE, invoiceNo: "b" });
    assert.equal(a, undefined);
    assert.equal(b, undefined);
    assert.equal(q.size, 2);
    assert.ok(q.oldestPendingAgeMs! >= 0);
    // Chain fixed at sale time: state already advanced past both.
    assert.equal(fd.getState()!.receiptGlobalNo, 12);
    // The flush attempt for "a" left its marker; the next flush settles it.
    assert.equal((await fd.pendingReceipt())!.receipt.receiptGlobalNo, 11);

    online = true;
    const res = await q.flush();
    assert.equal(res.remaining, 0);
    assert.deepEqual(res.submitted.map((s) => s.receipt.receiptGlobalNo), [11, 12]);
    assert.deepEqual(fdms.accepted, [11, 12]);
    assert.equal(fd.getState()!.receiptGlobalNo, 12);
  });

  it("stops at the first server rejection and keeps the rest", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const fd = await device(storage, fdms.transport);
    await fd.openDay();
    const q = new OfflineReceiptQueue(fd, new MemoryJournal());
    await q.enqueue({ ...SALE, invoiceNo: "a" });
    await q.enqueue({ ...SALE, invoiceNo: "b" });
    fdms.faults.rejectSubmit = true;
    const res = await q.flush();
    assert.equal(res.submitted.length, 0);
    assert.equal(res.remaining, 2);
    assert.ok(res.error instanceof FdmsApiError);
  });

  it("recovers a receipt journaled before the crash that lost the device state", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const journal = new MemoryJournal();
    const fd1 = await device(storage, fdms.transport);
    await fd1.openDay();
    const q1 = new OfflineReceiptQueue(fd1, journal);
    const prepared = await fd1.signReceipt(SALE);
    await journal.append(JSON.stringify(prepared)); // died before applyPrepared
    void q1;

    const fd2 = await device(storage, fdms.transport);
    await fd2.reconcile();
    assert.equal(fd2.getState()!.receiptGlobalNo, 10);
    const q2 = new OfflineReceiptQueue(fd2, journal);
    const res = await q2.flush();
    assert.deepEqual(res.submitted.map((s) => s.receipt.receiptGlobalNo), [11]);
    assert.equal(fd2.getState()!.receiptGlobalNo, 11);
  });

  it("settles a flush that died after writing the marker without a duplicate", async () => {
    const storage = new MemoryStorage();
    const fdms = fakeFdms();
    const journal = new MemoryJournal();
    const fd = await device(storage, fdms.transport);
    await fd.openDay();
    const q = new OfflineReceiptQueue(fd, journal);
    await q.enqueue(SALE);
    fdms.faults.dropAfterSubmit = true;
    const first = await q.flush();
    assert.ok(first.error instanceof TransportError);
    assert.equal(first.remaining, 1);
    assert.ok(await fd.pendingReceipt());

    const second = await q.flush();
    assert.equal(second.remaining, 0);
    assert.deepEqual(fdms.accepted, [11]);
    assert.equal(await fd.pendingReceipt(), undefined);
  });

  it("wraps a 0.3.x QueueStorage and signs its unsigned receipts at flush", async () => {
    const legacy = new MemoryQueueStorage();
    await legacy.save([{ ...SALE, invoiceNo: "old" }]);
    const fdms = fakeFdms();
    const fd = await device(new MemoryStorage(), fdms.transport);
    await fd.openDay();
    const q = new OfflineReceiptQueue(fd, legacy);
    await q.enqueue({ ...SALE, invoiceNo: "new" });
    assert.equal(q.size, 2);
    const res = await q.flush();
    assert.equal(res.remaining, 0);
    assert.deepEqual(fdms.accepted, [11, 12]);
    assert.deepEqual(await legacy.load(), []);
  });
  void offline;
});

describe("file storage and journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "zimra-crash-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

  it("FileStorage round-trips and uses the CLI profile file names", async () => {
    const s = new FileStorage(dir);
    await s.set("day-state", '{"a":1}');
    assert.equal(readFileSync(join(dir, "day-state.json"), "utf-8"), '{"a":1}');
    assert.equal(await s.get("day-state"), '{"a":1}');
    await s.delete("day-state");
    assert.equal(await s.get("day-state"), null);
    await assert.rejects(s.set("../x", ""));
  });

  it("FileJournal appends, commits and drops a torn last line", async () => {
    const j = new FileJournal(dir, "t");
    await j.append('{"n":1}');
    await j.append('{"n":2}');
    writeFileSync(join(dir, "t.jsonl"), '{"n":3', { flag: "a" }); // crash mid-append
    assert.deepEqual((await j.readFrom(0)).map((e) => e.record), ['{"n":1}', '{"n":2}']);
    await j.commit(1);
    assert.equal(await j.committed(), 1);
    assert.deepEqual((await j.readFrom(await j.committed())).map((e) => e.cursor), [1]);
    await j.compact();
    assert.equal(await j.committed(), 0);
    assert.deepEqual((await j.readFrom(0)).map((e) => e.record), ['{"n":2}']);
    assert.ok(existsSync(join(dir, "t.cursor")));
  });
});
