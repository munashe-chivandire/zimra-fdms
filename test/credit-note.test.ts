/**
 * Credit note sign convention. FDMS v7.2 section 4.7: a credit note's Sale
 * line prices are < 0 (RCPT022), its payments <= 0 (RCPT028) and its
 * receiptTotal <= 0 (RCPT040). Callers give positive amounts; the SDK sends
 * and signs them negative. Counters are the same as before the change.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FiscalDevice, ReceiptValidationError, accumulateCounters, type ReceiptInput } from "../src/core/device.js";
import { MemoryStorage } from "../src/core/storage.js";
import type { Transport } from "../src/core/transport.js";
import { cents } from "../src/core/money.js";
import { receiptSigningString } from "../src/core/signing.js";
import { generatePemSigner } from "../src/node/pem-signer.js";
import type { FiscalDayCounter, Receipt } from "../src/core/types.js";

const DEVICE = { deviceId: 7, serialNumber: "S", modelName: "M", modelVersion: "1" };

const SALE: ReceiptInput = {
  currency: "USD",
  invoiceNo: "INV-1",
  lines: [
    { name: "Bread", price: cents("11.50"), quantity: 2, taxId: 3, taxPercent: 15, taxCode: "A" },
    { name: "Milk", price: 4, quantity: 1, taxId: 1, taxPercent: null, taxCode: "C" },
  ],
  payments: [{ moneyType: "Cash", amount: 20 }, { moneyType: "Card", amount: 7 }],
};
const CREDIT: ReceiptInput = { ...SALE, receiptType: "CreditNote", invoiceNo: "CN-1", creditDebitNote: { receiptID: 4711 } };

async function openDevice() {
  const transport: Transport = {
    request: async (req) => {
      const path = new URL(req.url).pathname.split("/").pop()!;
      const reply = (obj: unknown) => ({ status: 200, headers: { date: new Date().toUTCString() }, text: JSON.stringify(obj) });
      if (path === "GetStatus") return reply({ fiscalDayStatus: "FiscalDayClosed", lastReceiptGlobalNo: 10 });
      if (path === "OpenDay") return reply({ fiscalDayNo: 3, operationID: "op" });
      return { status: 404, headers: {}, text: "" };
    },
  };
  const { signer } = await generatePemSigner();
  const fd = new FiscalDevice(DEVICE, { signer, transport, storage: new MemoryStorage() });
  await fd.openDay();
  return fd;
}

describe("credit note sign convention", () => {
  it("sends every amount of a credit note negative", async () => {
    const fd = await openDevice();
    const { receipt } = await fd.signReceipt(CREDIT);
    assert.deepEqual(receipt.receiptLines.map((l) => [l.receiptLinePrice, l.receiptLineTotal]), [[-11.5, -23], [-4, -4]]);
    assert.deepEqual(receipt.receiptTaxes.map((t) => [t.taxID, t.taxAmount, t.salesAmountWithTax]), [[1, 0, -4], [3, -3, -23]]);
    assert.deepEqual(receipt.receiptPayments.map((p) => p.paymentAmount), [-20, -7]);
    assert.equal(receipt.receiptTotal, -27);
  });

  it("signs the negative amounts", async () => {
    const fd = await openDevice();
    const { receipt } = await fd.signReceipt(CREDIT);
    const canonical = receiptSigningString(DEVICE.deviceId, receipt);
    assert.match(canonical, /^7CREDITNOTEUSD11\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-2700C0-400A15\.00-300-2300$/);
  });

  it("is the exact mirror of the same fiscal invoice", async () => {
    const sale = (await (await openDevice()).signReceipt(SALE)).receipt;
    const credit = (await (await openDevice()).signReceipt(CREDIT)).receipt;
    assert.equal(credit.receiptTotal, 0 - sale.receiptTotal);
    assert.deepEqual(credit.receiptTaxes.map((t) => [t.taxAmount, t.salesAmountWithTax]), sale.receiptTaxes.map((t) => [0 - t.taxAmount, 0 - t.salesAmountWithTax]));
  });

  it("rounds a half-cent line total the same as the sale, then negates it", async () => {
    const half: ReceiptInput = {
      ...SALE,
      lines: [
        { name: "Fuel", price: cents("1.05"), quantity: 0.5, taxId: 3, taxPercent: 15 },
        { name: "Nails", price: cents("0.03"), quantity: 0.5, taxId: 3, taxPercent: 15 },
      ],
      payments: [{ moneyType: "Cash", amount: cents("0.55") }],
    };
    const sale = (await (await openDevice()).signReceipt(half)).receipt;
    const credit = (await (await openDevice()).signReceipt({ ...half, receiptType: "CreditNote", invoiceNo: "CN-1", creditDebitNote: { receiptID: 4711 } })).receipt;
    assert.deepEqual(sale.receiptLines.map((l) => l.receiptLineTotal), [0.53, 0.02]);
    assert.deepEqual(credit.receiptLines.map((l) => l.receiptLineTotal), [-0.53, -0.02]);
    assert.equal(credit.receiptTotal, -0.55);
    assert.deepEqual(credit.receiptTaxes.map((t) => t.taxAmount), sale.receiptTaxes.map((t) => 0 - t.taxAmount));
  });

  it("leaves debit notes and fiscal invoices positive", async () => {
    const fd = await openDevice();
    const debit = (await fd.signReceipt({ ...CREDIT, receiptType: "DebitNote" })).receipt;
    assert.equal(debit.receiptTotal, 27);
    assert.ok(debit.receiptLines.every((l) => l.receiptLinePrice! > 0));
    assert.ok(debit.receiptPayments.every((p) => p.paymentAmount >= 0));
  });

  it("lowers the day counters by the credited amounts", async () => {
    const fd = await openDevice();
    await fd.applyPrepared(await fd.signReceipt(CREDIT));
    const counters = Object.fromEntries(
      fd.getState()!.counters.map((c) => [`${c.fiscalCounterType}|${c.fiscalCounterTaxID ?? c.fiscalCounterMoneyType}`, c.fiscalCounterValue]),
    );
    assert.deepEqual(counters, {
      "CreditNoteByTax|1": -4,
      "CreditNoteTaxByTax|1": 0,
      "CreditNoteByTax|3": -23,
      "CreditNoteTaxByTax|3": -3,
      "BalanceByMoneyType|Cash": -20,
      "BalanceByMoneyType|Card": -7,
    });
  });

  it("counts a credit note signed positive by 0.4.x the same as a negative one", async () => {
    const fd = await openDevice();
    const negative = (await fd.signReceipt(CREDIT)).receipt;
    const positive: Receipt = {
      ...negative,
      receiptTaxes: negative.receiptTaxes.map((t) => ({ ...t, taxAmount: Math.abs(t.taxAmount), salesAmountWithTax: Math.abs(t.salesAmountWithTax) })),
      receiptPayments: negative.receiptPayments.map((p) => ({ ...p, paymentAmount: Math.abs(p.paymentAmount) })),
      receiptTotal: Math.abs(negative.receiptTotal),
    };
    const a: FiscalDayCounter[] = [];
    const b: FiscalDayCounter[] = [];
    accumulateCounters(a, negative);
    accumulateCounters(b, positive);
    assert.deepEqual(b, a);
  });

  for (const [name, field, input] of [
    ["a zero price", "lines[0].price", { ...CREDIT, lines: [{ ...SALE.lines[0]!, price: 0 }] }],
    ["a negative price", "lines[0].price", { ...CREDIT, lines: [{ ...SALE.lines[0]!, price: cents("-11.50") }] }],
    ["a negative payment", "payments[0].amount", { ...CREDIT, payments: [{ moneyType: "Cash", amount: -20 }, { moneyType: "Card", amount: 47 }] }],
    ["a negative price on an invoice", "lines[0].price", { ...SALE, lines: [{ ...SALE.lines[0]!, price: -1 }] }],
  ] as const) {
    it(`refuses ${name}, naming ${field}`, async () => {
      const fd = await openDevice();
      await assert.rejects(fd.signReceipt(input as ReceiptInput), (err: unknown) => {
        assert.ok(err instanceof ReceiptValidationError, String(err));
        assert.equal(err.field, field);
        return true;
      });
    });
  }

  it("still accepts a zero payment line", async () => {
    const fd = await openDevice();
    const { receipt } = await fd.signReceipt({ ...CREDIT, payments: [{ moneyType: "Cash", amount: 27 }, { moneyType: "Card", amount: 0 }] });
    assert.deepEqual(receipt.receiptPayments.map((p) => p.paymentAmount), [-27, 0]);
  });
});
