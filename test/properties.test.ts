/**
 * Seeded property tests for the signing strings, money conversion and the
 * fiscal-day counters.
 *
 * Each property runs over many generated inputs from a fixed seed, so a
 * failure names a reproducible case. The expected values are computed with
 * plain integer cents, independently of the float amounts the SDK stores.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FiscalDevice, accumulateCounters, buildReceiptTaxes } from "../src/core/device.js";
import {
  concatenateReceiptTaxes,
  fiscalDaySigningString,
  sha256Base64,
  toCents,
} from "../src/core/signing.js";
import { centsToAmount, cents, formatCents } from "../src/core/money.js";
import type { Transport } from "../src/core/transport.js";
import type {
  FiscalDayCounter,
  MoneyType,
  Payment,
  Receipt,
  ReceiptLine,
  ReceiptTax,
  ReceiptType,
} from "../src/core/types.js";
import { generatePemSigner } from "../src/node/pem-signer.js";
import { rng } from "./prng.js";

type Rand = () => number;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function shuffle<T>(r: Rand, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const MONEY_TYPES: readonly MoneyType[] = [
  "Cash", "Card", "MobileWallet", "Coupon", "Credit", "BankTransfer", "Other",
];

/** A device tax table: each taxID has one percent, as FDMS configures it. */
const TAXES = [
  { taxID: 1, taxPercent: null, taxCode: "A" }, // exempt
  { taxID: 2, taxPercent: 0, taxCode: "B" }, // zero-rated: tax counters stay 0
  { taxID: 3, taxPercent: 15, taxCode: "C" },
  { taxID: 4, taxPercent: 14.5, taxCode: null },
  { taxID: 5, taxPercent: 5, taxCode: "E" },
] as const;

function randomLine(r: Rand, no: number): ReceiptLine {
  const t = pick(r, TAXES);
  const totalCents = int(r, 1, 2_000_000);
  return {
    receiptLineType: "Sale",
    receiptLineNo: no,
    receiptLineHSCode: null,
    receiptLineName: `line ${no}`,
    receiptLinePrice: centsToAmount(totalCents),
    receiptLineQuantity: 1,
    receiptLineTotal: centsToAmount(totalCents),
    taxCode: t.taxCode,
    taxPercent: t.taxPercent,
    taxID: t.taxID,
  };
}

/** Split totalCents over 1..3 payments, possibly repeating a money type. */
function randomPayments(r: Rand, totalCents: number): Payment[] {
  const n = int(r, 1, 3);
  const out: Payment[] = [];
  let left = totalCents;
  for (let i = 0; i < n; i++) {
    const part = i === n - 1 ? left : int(r, 0, left);
    left -= part;
    out.push({ moneyTypeCode: pick(r, MONEY_TYPES), paymentAmount: centsToAmount(part) });
  }
  return out;
}

/** Line amounts negated: FDMS v7.2 wants credit notes negative (RCPT022). */
function negateLine(l: ReceiptLine): ReceiptLine {
  return { ...l, receiptLinePrice: 0 - (l.receiptLinePrice ?? 0), receiptLineTotal: 0 - l.receiptLineTotal };
}

function randomReceipt(r: Rand, n: number): Receipt {
  const receiptType = pick<ReceiptType>(r, ["FiscalInvoice", "FiscalInvoice", "CreditNote", "DebitNote"]);
  const sign = receiptType === "CreditNote" ? -1 : 1;
  const positive = Array.from({ length: int(r, 1, 6) }, (_, i) => randomLine(r, i + 1));
  const lines = sign < 0 ? positive.map(negateLine) : positive;
  const inclusive = r() < 0.5;
  const taxes = buildReceiptTaxes(lines, inclusive);
  const totalCents = taxes.reduce((s, t) => s + toCents(t.salesAmountWithTax), 0);
  return {
    receiptType,
    receiptCurrency: pick(r, ["USD", "usd", "Usd", "ZWG", "zwg"]),
    receiptCounter: n,
    receiptGlobalNo: 100 + n,
    invoiceNo: `INV-${n}`,
    receiptDate: "2026-07-29T10:00:00",
    receiptLinesTaxInclusive: inclusive,
    receiptLines: lines,
    receiptTaxes: taxes,
    receiptPayments: randomPayments(r, sign * totalCents).map((p) => ({
      ...p,
      paymentAmount: sign < 0 ? 0 - p.paymentAmount : p.paymentAmount,
    })),
    receiptTotal: centsToAmount(totalCents),
    receiptDeviceSignature: { hash: "", signature: "" },
  };
}

const BY_TAX: Record<ReceiptType, [FiscalDayCounter["fiscalCounterType"], FiscalDayCounter["fiscalCounterType"]]> = {
  FiscalInvoice: ["SaleByTax", "SaleTaxByTax"],
  CreditNote: ["CreditNoteByTax", "CreditNoteTaxByTax"],
  DebitNote: ["DebitNoteByTax", "DebitNoteTaxByTax"],
};

const counterKey = (c: FiscalDayCounter) =>
  `${c.fiscalCounterType}|${c.fiscalCounterCurrency}|${c.fiscalCounterTaxID ?? ""}|${c.fiscalCounterMoneyType ?? ""}`;

/**
 * Expected counters in integer cents, built straight from the receipts.
 * Credit note amounts are already negative, so every receipt just adds.
 */
function expectedCounters(receipts: Receipt[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (key: string, v: number) => out.set(key, (out.get(key) ?? 0) + v);
  for (const rc of receipts) {
    const cur = rc.receiptCurrency.toUpperCase();
    const [byTax, taxByTax] = BY_TAX[rc.receiptType];
    for (const t of rc.receiptTaxes) {
      add(`${byTax}|${cur}|${t.taxID}|`, toCents(t.salesAmountWithTax));
      add(`${taxByTax}|${cur}|${t.taxID}|`, toCents(t.taxAmount));
    }
    for (const p of rc.receiptPayments) {
      add(`BalanceByMoneyType|${cur}||${p.moneyTypeCode}`, toCents(p.paymentAmount));
    }
  }
  return out;
}

describe("signing string properties", () => {
  it("receipt tax order in the signing string does not depend on input order", () => {
    const r = rng(0x7a11);
    const codes = [null, "A", "B", "a", "Z", "AB", "é", "😀", ""];
    for (let i = 0; i < 2000; i++) {
      // FDMS taxes are unique per (taxID, taxCode); ties are not generated.
      const seen = new Set<string>();
      const taxes: ReceiptTax[] = [];
      for (let k = int(r, 1, 8); k > 0; k--) {
        const taxID = int(r, 1, 6);
        const taxCode = pick(r, codes);
        if (seen.has(`${taxID}|${taxCode}`)) continue;
        seen.add(`${taxID}|${taxCode}`);
        taxes.push({
          taxID,
          taxCode,
          taxPercent: pick(r, [null, 0, 5, 14.5, 15]),
          taxAmount: centsToAmount(int(r, -500_000, 500_000)),
          salesAmountWithTax: centsToAmount(int(r, -5_000_000, 5_000_000)),
        });
      }
      const before = JSON.stringify(taxes);
      const want = concatenateReceiptTaxes(taxes);
      assert.equal(JSON.stringify(taxes), before, "input is not mutated");
      for (let s = 0; s < 3; s++) {
        assert.equal(concatenateReceiptTaxes(shuffle(r, taxes)), want, `case ${i}: ${before}`);
      }
    }
  });

  it("toCents(centsToAmount(c)) === c exhaustively for |c| <= 2,000,000", () => {
    for (let c = -2_000_000; c <= 2_000_000; c++) {
      if (toCents(centsToAmount(c)) !== c) assert.fail(`round trip failed for ${c}`);
    }
  });

  it("toCents(centsToAmount(c)) === c across magnitudes up to 2^51 cents", () => {
    // 2^51 cents is about 22.5 trillion major units. Above roughly 3.5e15
    // cents the float division by 100 loses the last cent, so the round trip
    // is only claimed below 2^51, far past any real receipt or day total.
    const r = rng(0xc3a7);
    for (let i = 0; i < 200_000; i++) {
      const mag = Math.floor(2 ** (r() * 51));
      const c = r() < 0.5 ? -mag : mag;
      if (toCents(centsToAmount(c)) !== c) assert.fail(`round trip failed for ${c}`);
      if (cents(formatCents(c)).cents !== c) assert.fail(`formatCents/cents failed for ${c}`);
    }
  });

  it("CloseDay string ignores zero counters and counter order", () => {
    const r = rng(0xc105e);
    for (let i = 0; i < 500; i++) {
      const counters: FiscalDayCounter[] = [];
      accumulateCounters(counters, randomReceipt(r, 1));
      accumulateCounters(counters, randomReceipt(r, 2));
      const withZeros = [
        ...counters,
        { fiscalCounterType: "SaleTaxByTax", fiscalCounterCurrency: "USD", fiscalCounterTaxID: 9, fiscalCounterTaxPercent: 0, fiscalCounterValue: 0 },
        { fiscalCounterType: "BalanceByMoneyType", fiscalCounterCurrency: "ZWG", fiscalCounterMoneyType: "Coupon", fiscalCounterValue: -0 },
      ] as FiscalDayCounter[];
      const nonZero = counters.filter((c) => toCents(c.fiscalCounterValue) !== 0);
      const want = fiscalDaySigningString(7, 9, "2026-07-29", nonZero);
      assert.equal(fiscalDaySigningString(7, 9, "2026-07-29", shuffle(r, withZeros)), want, `case ${i}`);
    }
  });
});

describe("fiscal-day counter properties", () => {
  it("counters over random receipts equal the receipts' own taxes and payments", () => {
    const r = rng(0xc0417);
    for (let run = 0; run < 300; run++) {
      const receipts = Array.from({ length: int(r, 1, 25) }, (_, i) => randomReceipt(r, i + 1));
      const counters: FiscalDayCounter[] = [];
      for (const rc of receipts) accumulateCounters(counters, rc);

      const got = new Map<string, number>();
      for (const c of counters) {
        const key = counterKey(c);
        assert.equal(got.has(key), false, `run ${run}: duplicate counter ${key}`);
        assert.equal(c.fiscalCounterCurrency, c.fiscalCounterCurrency.toUpperCase());
        got.set(key, toCents(c.fiscalCounterValue));
      }
      assert.deepEqual(
        [...got.entries()].sort(),
        [...expectedCounters(receipts).entries()].sort(),
        `run ${run}`,
      );

      // Per currency, the by-tax sales counters and the balance counters
      // both sum to the signed receipt totals.
      for (const cur of new Set(receipts.map((rc) => rc.receiptCurrency.toUpperCase()))) {
        const totals = receipts
          .filter((rc) => rc.receiptCurrency.toUpperCase() === cur)
          .reduce((s, rc) => s + toCents(rc.receiptTotal), 0);
        const sum = (types: string[]) =>
          counters
            .filter((c) => c.fiscalCounterCurrency === cur && types.includes(c.fiscalCounterType))
            .reduce((s, c) => s + toCents(c.fiscalCounterValue), 0);
        assert.equal(sum(["SaleByTax", "CreditNoteByTax", "DebitNoteByTax"]), totals, `run ${run} ${cur} by tax`);
        assert.equal(sum(["BalanceByMoneyType"]), totals, `run ${run} ${cur} balance`);
      }
    }
  });

  it("closeDay never sends or signs a zero counter", async () => {
    const { signer } = await generatePemSigner();
    let closeBody: any;
    const transport: Transport = {
      request: async (req) => {
        closeBody = req.body ? JSON.parse(req.body) : undefined;
        return { status: 200, headers: { date: new Date().toUTCString() }, text: JSON.stringify({ operationID: "op" }) };
      },
    };
    const device = { deviceId: 7, serialNumber: "S", modelName: "M", modelVersion: "1" };
    const r = rng(0x2e60);
    let sawZero = 0;
    for (let run = 0; run < 40; run++) {
      const counters: FiscalDayCounter[] = [];
      const receipts = Array.from({ length: int(r, 1, 10) }, (_, i) => randomReceipt(r, i + 1));
      for (const rc of receipts) accumulateCounters(counters, rc);
      // A receipt that mirrors the first one with the other type and sign
      // cancels its balance counters to zero, alongside any zero-rated tax
      // counters.
      const first = receipts[0]!;
      accumulateCounters(counters, {
        ...first,
        receiptType: first.receiptType === "CreditNote" ? "FiscalInvoice" : "CreditNote",
        receiptLines: first.receiptLines.map(negateLine),
        receiptTaxes: first.receiptTaxes.map((t) => ({ ...t, taxAmount: 0 - t.taxAmount, salesAmountWithTax: 0 - t.salesAmountWithTax })),
        receiptPayments: first.receiptPayments.map((p) => ({ ...p, paymentAmount: 0 - p.paymentAmount })),
        receiptTotal: 0 - first.receiptTotal,
      });
      sawZero += counters.filter((c) => toCents(c.fiscalCounterValue) === 0).length;

      const fd = new FiscalDevice(device, { signer, transport });
      fd.restoreState({
        fiscalDayNo: 9,
        fiscalDayDate: "2026-07-29",
        receiptCounter: receipts.length + 1,
        receiptGlobalNo: 200,
        previousReceiptHash: "H",
        counters: JSON.parse(JSON.stringify(counters)),
      });
      await fd.closeDay();

      const sent = closeBody.fiscalDayCounters as FiscalDayCounter[];
      assert.ok(sent.every((c) => toCents(c.fiscalCounterValue) !== 0), `run ${run}: zero counter sent`);
      assert.equal(
        sent.length,
        counters.filter((c) => toCents(c.fiscalCounterValue) !== 0).length,
        `run ${run}: every non-zero counter is sent`,
      );
      assert.equal(
        closeBody.fiscalDayDeviceSignature.hash,
        sha256Base64(fiscalDaySigningString(7, 9, "2026-07-29", sent)),
        `run ${run}: signed string covers exactly the sent counters`,
      );
    }
    assert.ok(sawZero > 0, "the generator produced zero counters");
  });
});
