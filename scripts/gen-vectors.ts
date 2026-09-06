/**
 * Generate vectors/zimra-fdms-vectors.json: canonical strings, hashes and
 * signatures for a fixed P-256 test key, so any port in any language can
 * prove it formats and signs exactly as FDMS expects.
 *
 * The signatures are one valid signature each (ECDSA is randomised), so a
 * port checks canonical strings and hashes byte for byte and verifies its
 * own signatures against publicKeyPem. The test key is public by design;
 * never register a real device with it.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generatePemSigner, PemSigner } from "../src/node/pem-signer.js";
import { buildReceiptTaxes, accumulateCounters } from "../src/core/device.js";
import { receiptSigningString, fiscalDaySigningString, concatenateReceiptTaxes } from "../src/core/signing.js";
import { sha256Base64 } from "../src/core/sha256.js";
import { receiptQrData } from "../src/core/qr.js";
import { signCanonicalString } from "../src/core/signer.js";
import type { FiscalDayCounter, Receipt, ReceiptLine } from "../src/core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "vectors");
const keyPath = join(dir, "test-key.pem");

let privateKeyPem: string;
if (existsSync(keyPath)) {
  privateKeyPem = readFileSync(keyPath, "utf-8");
} else {
  ({ privateKeyPem } = await generatePemSigner());
  writeFileSync(keyPath, privateKeyPem);
}
const signer = new PemSigner(privateKeyPem);
const publicKeyPem = await signer.publicKeyPem();

const DEVICE_ID = 37367;

function line(n: number, name: string, price: number, qty: number, taxID: number, taxPercent: number | null, taxCode: string | null = null): ReceiptLine {
  return {
    receiptLineType: "Sale",
    receiptLineNo: n,
    receiptLineHSCode: null,
    receiptLineName: name,
    receiptLinePrice: price,
    receiptLineQuantity: qty,
    receiptLineTotal: Math.round(price * qty * 100) / 100,
    taxCode,
    taxPercent,
    taxID,
  };
}

function receipt(
  p: {
    type?: Receipt["receiptType"];
    currency: string;
    counter: number;
    globalNo: number;
    invoiceNo: string;
    date: string;
    inclusive: boolean;
    lines: ReceiptLine[];
    payments: { moneyTypeCode: Receipt["receiptPayments"][number]["moneyTypeCode"]; paymentAmount: number }[];
  },
): Omit<Receipt, "receiptDeviceSignature"> {
  const taxes = buildReceiptTaxes(p.lines, p.inclusive);
  const linesTotal = p.lines.reduce((s, l) => s + Math.round(l.receiptLineTotal * 100), 0);
  const taxTotal = taxes.reduce((s, t) => s + Math.round(t.taxAmount * 100), 0);
  return {
    receiptType: p.type ?? "FiscalInvoice",
    receiptCurrency: p.currency,
    receiptCounter: p.counter,
    receiptGlobalNo: p.globalNo,
    invoiceNo: p.invoiceNo,
    buyerData: null,
    receiptNotes: null,
    receiptDate: p.date,
    creditDebitNote: null,
    receiptLinesTaxInclusive: p.inclusive,
    receiptLines: p.lines,
    receiptTaxes: taxes,
    receiptPayments: p.payments,
    receiptTotal: (linesTotal + (p.inclusive ? 0 : taxTotal)) / 100,
    receiptPrintForm: "Receipt48",
  };
}

const receipts = [
  {
    name: "USD, one 15% line, tax inclusive, first receipt of the day (no previous hash)",
    previousReceiptHash: null as string | null,
    receipt: receipt({
      currency: "USD", counter: 1, globalNo: 24, invoiceNo: "INV-0001", date: "2026-09-06T12:18:39", inclusive: true,
      lines: [line(1, "Consulting", 115, 1, 1, 15, "A")],
      payments: [{ moneyTypeCode: "Cash", paymentAmount: 115 }],
    }),
  },
  {
    name: "USD, mixed 15%, 0% and exempt lines, tax inclusive, chained",
    previousReceiptHash: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
    receipt: receipt({
      currency: "USD", counter: 2, globalNo: 25, invoiceNo: "INV-0002", date: "2026-09-06T12:19:01", inclusive: true,
      lines: [line(1, "Bread", 2.5, 2, 1, 15, "A"), line(2, "Maize meal", 10, 1, 2, 0, "B"), line(3, "Medicine", 7.25, 3, 3, null, "C")],
      payments: [{ moneyTypeCode: "Cash", paymentAmount: 20 }, { moneyTypeCode: "Card", paymentAmount: 16.75 }],
    }),
  },
  {
    name: "ZWG, tax exclusive, quantities with fractions",
    previousReceiptHash: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    receipt: receipt({
      currency: "ZWG", counter: 3, globalNo: 26, invoiceNo: "INV-0003", date: "2026-09-06T13:00:00", inclusive: false,
      lines: [line(1, "Fuel", 1.85, 37.5, 1, 15), line(2, "Oil", 12.99, 1, 1, 15)],
      payments: [{ moneyTypeCode: "MobileWallet", paymentAmount: 94.72 }],
    }),
  },
  {
    name: "Credit note against an earlier receipt",
    previousReceiptHash: "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=",
    receipt: receipt({
      type: "CreditNote", currency: "USD", counter: 4, globalNo: 27, invoiceNo: "CN-0001", date: "2026-09-06T14:30:15", inclusive: true,
      lines: [line(1, "Consulting", 115, 1, 1, 15, "A")],
      payments: [{ moneyTypeCode: "Cash", paymentAmount: 115 }],
    }),
  },
  {
    name: "Large amounts near the 2^31 cents boundary",
    previousReceiptHash: null,
    receipt: receipt({
      currency: "ZWG", counter: 1, globalNo: 28, invoiceNo: "INV-BIG", date: "2026-09-07T08:00:00", inclusive: true,
      lines: [line(1, "Equipment", 21474836.47, 1, 1, 15)],
      payments: [{ moneyTypeCode: "BankTransfer", paymentAmount: 21474836.47 }],
    }),
  },
];

const receiptVectors = [];
for (const r of receipts) {
  const canonical = receiptSigningString(DEVICE_ID, r.receipt, r.previousReceiptHash ?? undefined);
  const sig = await signCanonicalString(signer, canonical, "der");
  receiptVectors.push({
    name: r.name,
    deviceId: DEVICE_ID,
    previousReceiptHash: r.previousReceiptHash,
    receipt: r.receipt,
    taxBlock: concatenateReceiptTaxes(r.receipt.receiptTaxes),
    canonical,
    hash: sig.hash,
    signature: sig.signature,
  });
}

// Fiscal days: counters accumulated from the receipts above, plus edge cases.
const dayA: FiscalDayCounter[] = [];
for (const r of receipts.slice(0, 4)) {
  accumulateCounters(dayA, { ...r.receipt, receiptDeviceSignature: { hash: "", signature: "" } });
}
const days = [
  { name: "Counters from the four USD/ZWG receipts, including a credit note", fiscalDayNo: 19, fiscalDayDate: "2026-09-06", counters: dayA },
  {
    name: "Balance counters sort by money type enum order, not alphabetically; zero counters skipped",
    fiscalDayNo: 20,
    fiscalDayDate: "2026-09-07",
    counters: [
      { fiscalCounterType: "BalanceByMoneyType", fiscalCounterCurrency: "USD", fiscalCounterMoneyType: "Other", fiscalCounterValue: 1 },
      { fiscalCounterType: "BalanceByMoneyType", fiscalCounterCurrency: "USD", fiscalCounterMoneyType: "Cash", fiscalCounterValue: 2 },
      { fiscalCounterType: "BalanceByMoneyType", fiscalCounterCurrency: "USD", fiscalCounterMoneyType: "Coupon", fiscalCounterValue: 0 },
      { fiscalCounterType: "BalanceByMoneyType", fiscalCounterCurrency: "USD", fiscalCounterMoneyType: "Card", fiscalCounterValue: 3 },
      { fiscalCounterType: "SaleByTax", fiscalCounterCurrency: "USD", fiscalCounterTaxID: 3, fiscalCounterTaxPercent: null, fiscalCounterValue: 6 },
      { fiscalCounterType: "SaleByTax", fiscalCounterCurrency: "USD", fiscalCounterTaxID: 1, fiscalCounterTaxPercent: 15, fiscalCounterValue: 0 },
    ] as FiscalDayCounter[],
  },
  {
    name: "Two currencies interleaved; currency sorts within a counter type",
    fiscalDayNo: 21,
    fiscalDayDate: "2026-09-08",
    counters: [
      { fiscalCounterType: "SaleByTax", fiscalCounterCurrency: "ZWG", fiscalCounterTaxID: 1, fiscalCounterTaxPercent: 15, fiscalCounterValue: 100 },
      { fiscalCounterType: "SaleTaxByTax", fiscalCounterCurrency: "ZWG", fiscalCounterTaxID: 1, fiscalCounterTaxPercent: 15, fiscalCounterValue: 13.04 },
      { fiscalCounterType: "SaleByTax", fiscalCounterCurrency: "USD", fiscalCounterTaxID: 1, fiscalCounterTaxPercent: 15, fiscalCounterValue: 50 },
      { fiscalCounterType: "SaleTaxByTax", fiscalCounterCurrency: "USD", fiscalCounterTaxID: 1, fiscalCounterTaxPercent: 15, fiscalCounterValue: 6.52 },
      { fiscalCounterType: "BalanceByMoneyType", fiscalCounterCurrency: "ZWG", fiscalCounterMoneyType: "Cash", fiscalCounterValue: 100 },
      { fiscalCounterType: "BalanceByMoneyType", fiscalCounterCurrency: "USD", fiscalCounterMoneyType: "Cash", fiscalCounterValue: 50 },
    ] as FiscalDayCounter[],
  },
];
const dayVectors = [];
for (const d of days) {
  const canonical = fiscalDaySigningString(DEVICE_ID, d.fiscalDayNo, d.fiscalDayDate, d.counters);
  const sig = await signCanonicalString(signer, canonical, "der");
  dayVectors.push({ name: d.name, deviceId: DEVICE_ID, ...d, canonical, hash: sig.hash, signature: sig.signature });
}

const qrVectors = [
  {
    name: "Receipt 24 on the test environment (verified live 2026-09-06)",
    qrUrl: "https://fdmstest.zimra.co.zw",
    deviceId: DEVICE_ID,
    receiptDate: "2026-09-06T12:18:39",
    receiptGlobalNo: 24,
    deviceSignatureBase64: receiptVectors[0]!.signature,
  },
  {
    name: "qrUrl with trailing slash, single-digit day and month",
    qrUrl: "https://fdms.zimra.co.zw/",
    deviceId: 12,
    receiptDate: "2026-01-05T00:00:01",
    receiptGlobalNo: 1,
    deviceSignatureBase64: receiptVectors[1]!.signature,
  },
].map((q) => ({
  ...q,
  expected: receiptQrData({ ...q, receiptDate: new Date(q.receiptDate) }),
}));

const hashVectors = ["", "abc", "37367FISCALINVOICEUSD242026-09-06T12:18:3911500", "æøå 漢字 🎉"].map((input) => ({
  input,
  sha256Base64: sha256Base64(input),
}));

const taxVectors = [
  { name: "Inclusive 15%: 23.00 -> tax 3.00", lines: [line(1, "a", 11.5, 2, 1, 15)], taxInclusive: true },
  { name: "Exclusive 15%: 100.00 -> tax 15.00, sales 115.00", lines: [line(1, "a", 100, 1, 1, 15)], taxInclusive: false },
  { name: "Per-line rounding: 0.30 and 0.20 inclusive at 15% give 0.04 + 0.03", lines: [line(1, "a", 0.1, 3, 1, 15), line(2, "b", 0.2, 1, 1, 15)], taxInclusive: true },
  { name: "Exempt and zero-rated grouped separately from 15%", lines: [line(1, "a", 10, 1, 3, null), line(2, "b", 10, 1, 2, 0), line(3, "c", 10, 1, 1, 15)], taxInclusive: true },
].map((t) => ({ ...t, expected: buildReceiptTaxes(t.lines, t.taxInclusive) }));

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  description:
    "Conformance vectors for the ZIMRA FDMS receipt and fiscal-day signing rules. Canonical strings and hashes must match byte for byte. Signatures are ECDSA P-256 over SHA-256, ASN.1 DER, and verify against publicKeyPem; a port verifies its own signatures rather than comparing bytes.",
  deviceId: DEVICE_ID,
  publicKeyPem,
  privateKeyPem,
  receipts: receiptVectors,
  fiscalDays: dayVectors,
  qr: qrVectors,
  sha256: hashVectors,
  taxes: taxVectors,
};
writeFileSync(join(dir, "zimra-fdms-vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${receiptVectors.length} receipt, ${dayVectors.length} day, ${qrVectors.length} qr, ${hashVectors.length} hash, ${taxVectors.length} tax vectors`);
