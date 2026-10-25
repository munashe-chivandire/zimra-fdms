/**
 * Receipt tax arithmetic: buildReceiptTaxes against exact rational rounding.
 *
 * FDMS rejects a receipt whose tax does not match its lines, and a one-cent
 * drift in a tax amount changes the signed string. The reference here is
 * BigInt arithmetic with half-away-from-zero rounding, so it cannot share a
 * float bug with the code under test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReceiptTaxes } from "../src/core/device.js";
import { toCents } from "../src/core/signing.js";
import type { ReceiptLine } from "../src/core/types.js";
import { rng } from "./prng.js";

function line(totalCents: number, taxPercent: number | null, no = 1, taxID = 1): ReceiptLine {
  return {
    receiptLineType: "Sale",
    receiptLineNo: no,
    receiptLineHSCode: null,
    receiptLineName: `line ${no}`,
    receiptLinePrice: totalCents / 100,
    receiptLineQuantity: 1,
    receiptLineTotal: totalCents / 100,
    taxCode: null,
    taxPercent,
    taxID,
  };
}

/** Exact tax in cents: total * bp / 10000 (exclusive) or / (10000 + bp) (inclusive). */
function exactTaxCents(totalCents: number, bp: number, inclusive: boolean): number {
  const n = BigInt(totalCents) * BigInt(bp);
  const d = BigInt(inclusive ? 10000 + bp : 10000);
  const abs = n < 0n ? -n : n;
  let q = abs / d;
  if ((abs % d) * 2n >= d) q += 1n;
  return Number(n < 0n ? -q : q);
}

function taxCentsOf(totalCents: number, taxPercent: number, inclusive: boolean): number {
  const [t] = buildReceiptTaxes([line(totalCents, taxPercent)], inclusive);
  return toCents(t!.taxAmount);
}

describe("receipt tax arithmetic", () => {
  it("$1.00 at 14.5% tax-exclusive is 15 cents, not 14", () => {
    const [t] = buildReceiptTaxes([line(100, 14.5)], false);
    assert.equal(t!.taxAmount, 0.15);
    assert.equal(t!.salesAmountWithTax, 1.15);
  });

  it("matches exact rounding for every total up to $3,000 at common rates", () => {
    for (const percent of [14.5, 15, 15.5, 5, 0.5, 7.25, 12.5]) {
      const bp = Math.round(percent * 100);
      for (const inclusive of [true, false]) {
        for (let c = 0; c <= 300_000; c++) {
          const got = taxCentsOf(c, percent, inclusive);
          if (got !== exactTaxCents(c, bp, inclusive)) {
            assert.fail(`${c} cents at ${percent}% ${inclusive ? "inclusive" : "exclusive"}: got ${got}, want ${exactTaxCents(c, bp, inclusive)}`);
          }
        }
      }
    }
  });

  it("matches exact rounding for random totals, rates and signs", () => {
    const next = rng(0x5eed);
    for (let i = 0; i < 200_000; i++) {
      const bp = Math.floor(next() * 10_001); // 0.00% .. 100.00%
      const magnitude = Math.floor(next() * 1e10); // up to $100M
      const totalCents = next() < 0.2 ? -magnitude : magnitude;
      const inclusive = next() < 0.5;
      const percent = bp / 100;
      const got = taxCentsOf(totalCents, percent, inclusive);
      const want = exactTaxCents(totalCents, bp, inclusive);
      if (got !== want) {
        assert.fail(`${totalCents} cents at ${percent}% ${inclusive ? "inclusive" : "exclusive"}: got ${got}, want ${want}`);
      }
    }
  });

  it("rounds negative halves away from zero, mirroring the positive total", () => {
    // 10 cents at 5% exclusive is exactly 0.5 cent.
    assert.equal(taxCentsOf(10, 5, false), 1);
    assert.equal(taxCentsOf(-10, 5, false), -1);
    for (let c = 1; c <= 20_000; c++) {
      assert.equal(taxCentsOf(-c, 14.5, false), 0 - taxCentsOf(c, 14.5, false));
      assert.equal(taxCentsOf(-c, 15, true), 0 - taxCentsOf(c, 15, true));
    }
  });

  it("sums per-line rounded tax within a group and keeps exempt lines at zero", () => {
    const taxes = buildReceiptTaxes(
      [line(100, 14.5, 1), line(100, 14.5, 2), line(500, null, 3, 3)],
      false,
    );
    assert.deepEqual(
      taxes.map((t) => [t.taxID, t.taxAmount, t.salesAmountWithTax]),
      [
        [1, 0.3, 2.3],
        [3, 0, 5],
      ],
    );
  });

  it("refuses a non-finite tax percent or an amount too large to compute exactly", () => {
    assert.throws(() => buildReceiptTaxes([line(100, Number.NaN)], false), RangeError);
    assert.throws(() => buildReceiptTaxes([line(100, -100)], true), RangeError);
    assert.throws(() => buildReceiptTaxes([line(9e15, 15)], false), RangeError);
  });
});
