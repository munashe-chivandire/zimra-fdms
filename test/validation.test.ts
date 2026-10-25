/**
 * signReceipt input validation: every bad ReceiptInput is refused with a
 * ReceiptValidationError naming the field, before anything is numbered,
 * signed or sent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FiscalDevice, ReceiptValidationError, type ReceiptInput } from "../src/core/device.js";
import { MemoryStorage } from "../src/core/storage.js";
import type { Transport } from "../src/core/transport.js";
import { cents } from "../src/core/money.js";
import { generatePemSigner } from "../src/node/pem-signer.js";

const DEVICE = { deviceId: 7, serialNumber: "S", modelName: "M", modelVersion: "1" };

const SALE: ReceiptInput = {
  currency: "USD",
  invoiceNo: "INV-1",
  lines: [{ name: "Bread", price: cents("11.50"), quantity: 2, taxId: 3, taxPercent: 15 }],
  payments: [{ moneyType: "Cash", amount: 23 }],
};

/** FDMS stand-in that accepts everything and counts SubmitReceipt calls. */
function fakeFdms() {
  const submits: unknown[] = [];
  const transport: Transport = {
    request: async (req) => {
      const path = new URL(req.url).pathname.split("/").pop()!;
      const reply = (obj: unknown) => ({ status: 200, headers: { date: new Date().toUTCString() }, text: JSON.stringify(obj) });
      switch (path) {
        case "GetStatus":
          return reply({ fiscalDayStatus: "FiscalDayClosed", lastReceiptGlobalNo: 10 });
        case "OpenDay":
          return reply({ fiscalDayNo: 3, operationID: "op" });
        case "SubmitReceipt": {
          const body = JSON.parse(req.body!);
          submits.push(body);
          return reply({ receiptID: body.receipt.receiptGlobalNo, validationErrors: [], operationID: "op" });
        }
        default:
          return { status: 404, headers: {}, text: "" };
      }
    },
  };
  return { transport, submits };
}

async function openDevice() {
  const fdms = fakeFdms();
  const { signer } = await generatePemSigner();
  const fd = new FiscalDevice(DEVICE, { signer, transport: fdms.transport, storage: new MemoryStorage() });
  await fd.openDay();
  return { fd, fdms };
}

// Each case changes one field of SALE and names the field it must report.
const line = (patch: Record<string, unknown>) => ({ ...SALE, lines: [{ ...SALE.lines[0]!, ...patch }] });
const BAD: [string, string, unknown][] = [
  ["empty lines", "lines", { ...SALE, lines: [] }],
  ["empty payments", "payments", { ...SALE, payments: [] }],
  ["zero quantity", "lines[0].quantity", line({ quantity: 0 })],
  ["negative quantity", "lines[0].quantity", line({ quantity: -1 })],
  ["NaN quantity", "lines[0].quantity", line({ quantity: NaN })],
  ["infinite quantity", "lines[0].quantity", line({ quantity: Infinity })],
  ["string quantity", "lines[0].quantity", line({ quantity: "2" })],
  ["negative tax percent", "lines[0].taxPercent", line({ taxPercent: -15 })],
  ["NaN tax percent", "lines[0].taxPercent", line({ taxPercent: NaN })],
  ["fractional taxId", "lines[0].taxId", line({ taxId: 1.5 })],
  ["empty line name", "lines[0].name", line({ name: " " })],
  ["fractional float price", "lines[0].price", line({ price: 11.5 })],
  ["price too large for exact cents", "lines[0].price", line({ price: 1e308 })],
  ["null line", "lines[0]", { ...SALE, lines: [null] }],
  ["null payment", "payments[0]", { ...SALE, payments: [null] }],
  ["NaN payment", "payments[0].amount", { ...SALE, payments: [{ moneyType: "Cash", amount: NaN }] }],
  ["two-letter currency", "currency", { ...SALE, currency: "US" }],
  ["four-letter currency", "currency", { ...SALE, currency: "USDX" }],
  ["currency with digits", "currency", { ...SALE, currency: "U5D" }],
  ["empty invoiceNo", "invoiceNo", { ...SALE, invoiceNo: "" }],
  ["blank invoiceNo", "invoiceNo", { ...SALE, invoiceNo: "   " }],
  ["invoiceNo over 50 chars", "invoiceNo", { ...SALE, invoiceNo: "x".repeat(51) }],
  ["unknown receiptType", "receiptType", { ...SALE, receiptType: "Refund" }],
  ["invalid receiptDate", "receiptDate", { ...SALE, receiptDate: new Date("nope") }],
  ["payments not adding up", "payments", { ...SALE, payments: [{ moneyType: "Cash", amount: 22 }] }],
  ["credit note without creditDebitNote", "creditDebitNote", { ...SALE, receiptType: "CreditNote" }],
  ["debit note without creditDebitNote", "creditDebitNote", { ...SALE, receiptType: "DebitNote" }],
  ["credit note with null creditDebitNote", "creditDebitNote", { ...SALE, receiptType: "CreditNote", creditDebitNote: null }],
  ["credit note with empty creditDebitNote", "creditDebitNote", { ...SALE, receiptType: "CreditNote", creditDebitNote: {} }],
  ["credit note with all-null creditDebitNote", "creditDebitNote", {
    ...SALE, receiptType: "CreditNote",
    creditDebitNote: { receiptID: null, deviceID: null, receiptGlobalNo: null, fiscalDayNo: null },
  }],
  ["credit note with string creditDebitNote", "creditDebitNote", { ...SALE, receiptType: "CreditNote", creditDebitNote: "123" }],
  ["credit note with zero receiptID", "creditDebitNote.receiptID", { ...SALE, receiptType: "CreditNote", creditDebitNote: { receiptID: 0 } }],
  ["credit note with fractional receiptID", "creditDebitNote.receiptID", { ...SALE, receiptType: "CreditNote", creditDebitNote: { receiptID: 1.5 } }],
  ["credit note with receiptID and a negative deviceID", "creditDebitNote.deviceID", {
    ...SALE, receiptType: "CreditNote", creditDebitNote: { receiptID: 4711, deviceID: -5 },
  }],
  ["credit note missing fiscalDayNo", "creditDebitNote.fiscalDayNo", {
    ...SALE, receiptType: "CreditNote", creditDebitNote: { deviceID: 7, receiptGlobalNo: 11 },
  }],
  ["debit note missing deviceID", "creditDebitNote.deviceID", {
    ...SALE, receiptType: "DebitNote", creditDebitNote: { receiptGlobalNo: 11, fiscalDayNo: 3 },
  }],
  ["credit note with negative receiptGlobalNo", "creditDebitNote.receiptGlobalNo", {
    ...SALE, receiptType: "CreditNote", creditDebitNote: { deviceID: 7, receiptGlobalNo: -11, fiscalDayNo: 3 },
  }],
];

describe("signReceipt validates its input", () => {
  for (const [name, field, input] of BAD) {
    it(`refuses ${name} with field ${field}`, async () => {
      const { fd, fdms } = await openDevice();
      const before = JSON.stringify(fd.getState());
      await assert.rejects(fd.submitReceipt(input as ReceiptInput), (err: unknown) => {
        assert.ok(err instanceof ReceiptValidationError, `expected ReceiptValidationError, got ${String(err)}`);
        assert.equal(err.field, field);
        assert.ok(err.message.startsWith(`${field}: `));
        return true;
      });
      assert.equal(JSON.stringify(fd.getState()), before, "day state must not change");
      assert.equal(fdms.submits.length, 0, "nothing may be sent");
      assert.equal(await fd.pendingReceipt(), undefined, "no pending marker");
    });
  }

  it("still signs valid edge inputs: exempt line, zero tax, fractional quantity, lowercase currency", async () => {
    const { fd } = await openDevice();
    const prepared = await fd.signReceipt({
      currency: "zwg",
      invoiceNo: "x".repeat(50),
      lines: [
        { name: "Exempt", price: 10, quantity: 1, taxId: 1, taxPercent: null },
        { name: "Zero", price: 10, quantity: 1, taxId: 2, taxPercent: 0 },
        { name: "Fuel", price: 2, quantity: 0.5, taxId: 3, taxPercent: 15 },
      ],
      payments: [{ moneyType: "Cash", amount: 21 }],
    });
    assert.equal(prepared.receipt.receiptCurrency, "ZWG");
    assert.equal(prepared.receipt.receiptTotal, 21);
  });

  it("refuses an explicit receiptDate at or before the previous receipt's, and accepts a later one", async () => {
    const { fd, fdms } = await openDevice();
    const first = new Date(Date.now() + 5_000);
    await fd.submitReceipt({ ...SALE, receiptDate: first });
    const before = JSON.stringify(fd.getState());

    for (const date of [first, new Date(first.getTime() - 60_000), new Date(first.getTime() + 999 - (first.getTime() % 1000))]) {
      await assert.rejects(fd.submitReceipt({ ...SALE, invoiceNo: "INV-2", receiptDate: date }), (err: unknown) => {
        assert.ok(err instanceof ReceiptValidationError);
        assert.equal(err.field, "receiptDate");
        assert.match(err.message, /RCPT030/);
        return true;
      });
    }
    assert.equal(JSON.stringify(fd.getState()), before);
    assert.equal(fdms.submits.length, 1);

    const later = await fd.submitReceipt({ ...SALE, invoiceNo: "INV-2", receiptDate: new Date(first.getTime() + 1_000) });
    assert.equal(later.receipt.receiptCounter, 2);
    assert.equal(fdms.submits.length, 2);
  });

  it("signs credit and debit notes that reference the original receipt", async () => {
    const { fd, fdms } = await openDevice();
    const byId = await fd.submitReceipt({ ...SALE, receiptType: "CreditNote", invoiceNo: "CN-1", creditDebitNote: { receiptID: 4711 } });
    assert.deepEqual(byId.receipt.creditDebitNote, { receiptID: 4711 });
    const byNumber = { deviceID: 7, receiptGlobalNo: 11, fiscalDayNo: 3 };
    const debit = await fd.submitReceipt({ ...SALE, receiptType: "DebitNote", invoiceNo: "DN-1", creditDebitNote: byNumber });
    assert.deepEqual(debit.receipt.creditDebitNote, byNumber);
    assert.equal(fdms.submits.length, 2);
  });

  it("does not require creditDebitNote on a fiscal invoice", async () => {
    const { fd } = await openDevice();
    const prepared = await fd.signReceipt({ ...SALE, receiptType: "FiscalInvoice" });
    assert.equal(prepared.receipt.creditDebitNote, null);
  });

  it("is exported from the package root", async () => {
    const root = await import("../src/index.js");
    assert.equal(root.ReceiptValidationError, ReceiptValidationError);
  });
});
