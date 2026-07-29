/**
 * FDMS canonical signing strings, hashing and device signatures.
 *
 * These formats are load-bearing: a single wrong separator or rounding rule
 * yields RCPT010 signature-validation failures. Rules cross-checked against
 * the API documentation and community reference implementations.
 */
import { createHash, webcrypto } from "node:crypto";
import type {
  FiscalDayCounter,
  Receipt,
  ReceiptTax,
  SignatureData,
} from "./types.js";

/** Convert a currency amount to integer cents, avoiding float drift. */
export function toCents(amount: number): number {
  return Math.round(amount * 100 + (amount >= 0 ? 1e-9 : -1e-9) * 100);
}

/** Format a tax percent exactly as FDMS expects in signing strings: "15.00". */
export function formatTaxPercent(percent: number): string {
  return percent.toFixed(2);
}

/** Local date-time in FDMS format: YYYY-MM-DDTHH:mm:ss (no timezone). */
export function fdmsDateTime(d: Date = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Local date in FDMS fiscal-day format: YYYY-MM-DD. */
export function fdmsDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Tax block of the receipt signing string: taxes sorted by taxID, each as
 * [taxPercent 2dp, empty if exempt][taxAmount cents][salesAmountWithTax cents]
 */
export function concatenateReceiptTaxes(taxes: ReceiptTax[]): string {
  return [...taxes]
    .sort((a, b) => a.taxID - b.taxID)
    .map(
      (t) =>
        `${t.taxPercent !== undefined && t.taxPercent !== null ? formatTaxPercent(t.taxPercent) : ""}` +
        `${toCents(t.taxAmount)}` +
        `${toCents(t.salesAmountWithTax)}`,
    )
    .join("");
}

/**
 * Canonical receipt signing string:
 * deviceID + RECEIPTTYPE + CURRENCY + receiptGlobalNo + receiptDate +
 * receiptTotal(cents) + taxes + previousReceiptHash(base64, omitted for the
 * first receipt of a fiscal day).
 */
export function receiptSigningString(
  deviceId: number,
  receipt: Omit<Receipt, "receiptDeviceSignature">,
  previousReceiptHash?: string,
): string {
  return (
    `${deviceId}` +
    receipt.receiptType.toUpperCase() +
    receipt.receiptCurrency.toUpperCase() +
    `${receipt.receiptGlobalNo}` +
    receipt.receiptDate +
    `${toCents(receipt.receiptTotal)}` +
    concatenateReceiptTaxes(receipt.receiptTaxes) +
    (previousReceiptHash ?? "")
  );
}

const COUNTER_ORDER: Record<string, number> = {
  SaleByTax: 1,
  SaleTaxByTax: 2,
  CreditNoteByTax: 3,
  CreditNoteTaxByTax: 4,
  DebitNoteByTax: 5,
  DebitNoteTaxByTax: 6,
  BalanceByMoneyType: 7,
};

/** MoneyTypeEnum wire order — balance counters sort by this, not alphabetically. */
const MONEY_TYPE_ORDER: Record<string, number> = {
  Cash: 0,
  Card: 1,
  MobileWallet: 2,
  Coupon: 3,
  Credit: 4,
  BankTransfer: 5,
  Other: 6,
};

/**
 * Canonical fiscal-day (CloseDay) signing string:
 * deviceID + fiscalDayNo + fiscalDayDate(YYYY-MM-DD) + counters, where
 * counters are sorted by (type priority, currency, taxID/moneyType), zero
 * counters skipped, each as TYPE + CURRENCY + [taxPercent 2dp | moneyType] +
 * value(cents).
 */
export function fiscalDaySigningString(
  deviceId: number,
  fiscalDayNo: number,
  fiscalDayDate: string,
  counters: FiscalDayCounter[],
): string {
  const nonZero = counters.filter((c) => toCents(c.fiscalCounterValue) !== 0);
  const sorted = [...nonZero].sort((a, b) => {
    const pa = COUNTER_ORDER[a.fiscalCounterType] ?? 99;
    const pb = COUNTER_ORDER[b.fiscalCounterType] ?? 99;
    if (pa !== pb) return pa - pb;
    const cur = a.fiscalCounterCurrency.localeCompare(b.fiscalCounterCurrency);
    if (cur !== 0) return cur;
    const ta = a.fiscalCounterTaxID ?? -1;
    const tb = b.fiscalCounterTaxID ?? -1;
    if (ta !== tb) return ta - tb;
    const ma = MONEY_TYPE_ORDER[a.fiscalCounterMoneyType ?? ""] ?? 99;
    const mb = MONEY_TYPE_ORDER[b.fiscalCounterMoneyType ?? ""] ?? 99;
    return ma - mb;
  });

  const counterStr = sorted
    .map(
      (c) =>
        c.fiscalCounterType.toUpperCase() +
        c.fiscalCounterCurrency.toUpperCase() +
        (c.fiscalCounterTaxPercent !== undefined &&
        c.fiscalCounterTaxPercent !== null
          ? formatTaxPercent(c.fiscalCounterTaxPercent)
          : "") +
        (c.fiscalCounterMoneyType ? c.fiscalCounterMoneyType.toUpperCase() : "") +
        `${toCents(c.fiscalCounterValue)}`,
    )
    .join("");

  return `${deviceId}${fiscalDayNo}${fiscalDayDate}${counterStr}`;
}

/** base64(SHA-256(utf8 string)) — the `hash` field of SignatureData. */
export function sha256Base64(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("base64");
}

export type EcdsaSignatureFormat = "p1363" | "der";

/** Convert a raw IEEE P1363 (r||s) ECDSA signature to ASN.1 DER encoding. */
export function p1363ToDer(p1363: Buffer): Buffer {
  const half = p1363.length / 2;
  const encodeInt = (bytes: Buffer): Buffer => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.subarray(i);
    if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const r = encodeInt(p1363.subarray(0, half));
  const s = encodeInt(p1363.subarray(half));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

/**
 * Sign a canonical string with the device's ECDSA P-256 key.
 * FDMS verifies ASN.1 DER-encoded ECDSA signatures (confirmed against the
 * live test environment — raw P1363 is rejected with RCPT020 /
 * BadCertificateSignature), so DER is the default.
 */
export async function signCanonicalString(
  privateKeyPem: string,
  canonical: string,
  format: EcdsaSignatureFormat = "der",
): Promise<SignatureData> {
  const pem = privateKeyPem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const keyData = Buffer.from(pem, "base64");
  const key = await webcrypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const raw = Buffer.from(
    await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(canonical, "utf-8"),
    ),
  );
  const signature = format === "der" ? p1363ToDer(raw) : raw;
  return {
    hash: sha256Base64(canonical),
    signature: signature.toString("base64"),
  };
}
