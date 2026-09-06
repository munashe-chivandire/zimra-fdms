import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  concatenateReceiptTaxes,
  fdmsDate,
  fdmsDateTime,
  fiscalDaySigningString,
  formatTaxPercent,
  p1363ToDer,
  receiptSigningString,
  sha256Base64,
  signCanonicalString,
  toCents,
} from "../src/core/signing.js";
import { generateDeviceCsr, deviceCommonName } from "../src/node/keys.js";
import { PemSigner } from "../src/node/pem-signer.js";
import { receiptQrData } from "../src/core/qr.js";
import { buildReceiptTaxes, accumulateCounters } from "../src/core/device.js";
import type { FiscalDayCounter, Receipt, ReceiptLine } from "../src/core/types.js";

describe("toCents", () => {
  it("converts amounts without float drift", () => {
    assert.equal(toCents(115), 11500);
    assert.equal(toCents(0.1 + 0.2), 30); // 0.30000000000000004
    assert.equal(toCents(19.99), 1999);
    assert.equal(toCents(0), 0);
    assert.equal(toCents(1e-9), 0);
  });
});

describe("formatTaxPercent", () => {
  it("always renders two decimals", () => {
    assert.equal(formatTaxPercent(15), "15.00");
    assert.equal(formatTaxPercent(15.5), "15.50");
    assert.equal(formatTaxPercent(0), "0.00");
  });
});

describe("date formatting", () => {
  it("formats local date-time without timezone", () => {
    const d = new Date(2026, 6, 29, 10, 27, 30); // 2026-07-29 local
    assert.equal(fdmsDateTime(d), "2026-07-29T10:27:30");
    assert.equal(fdmsDate(d), "2026-07-29");
  });
  it("zero-pads all components", () => {
    const d = new Date(2026, 0, 5, 9, 8, 7);
    assert.equal(fdmsDateTime(d), "2026-01-05T09:08:07");
  });
});

describe("concatenateReceiptTaxes", () => {
  it("sorts by taxID and renders percent/cents", () => {
    const s = concatenateReceiptTaxes([
      { taxID: 3, taxPercent: 15, taxAmount: 15, salesAmountWithTax: 115 },
      { taxID: 1, taxPercent: null, taxAmount: 0, salesAmountWithTax: 10 },
    ]);
    // taxID 1 (exempt: no percent) then taxID 3
    assert.equal(s, "01000" + "15.00150011500");
  });

  it("renders zero-rate as 0.00", () => {
    const s = concatenateReceiptTaxes([
      { taxID: 513, taxPercent: 0, taxAmount: 0, salesAmountWithTax: 115 },
    ]);
    assert.equal(s, "0.00011500");
  });
});

describe("receiptSigningString", () => {
  const base = {
    receiptType: "FiscalInvoice" as const,
    receiptCurrency: "USD",
    receiptCounter: 1,
    receiptGlobalNo: 5,
    invoiceNo: "INV-1",
    receiptDate: "2026-07-29T10:27:30",
    receiptLinesTaxInclusive: true,
    receiptLines: [] as ReceiptLine[],
    receiptTaxes: [
      { taxID: 513, taxPercent: 0, taxAmount: 0, salesAmountWithTax: 115 },
    ],
    receiptPayments: [],
    receiptTotal: 115,
  };

  it("builds the canonical string for a first receipt (no previous hash)", () => {
    assert.equal(
      receiptSigningString(37367, base),
      "37367FISCALINVOICEUSD52026-07-29T10:27:3011500" + "0.00011500",
    );
  });

  it("appends the previous receipt hash when chained", () => {
    const s = receiptSigningString(37367, base, "PREVHASH==");
    assert.ok(s.endsWith("PREVHASH=="));
  });

  it("uppercases receipt type and currency", () => {
    const s = receiptSigningString(1, {
      ...base,
      receiptType: "CreditNote",
      receiptCurrency: "usd",
    });
    assert.ok(s.startsWith("1CREDITNOTEUSD"));
  });
});

describe("fiscalDaySigningString", () => {
  const counters: FiscalDayCounter[] = [
    {
      fiscalCounterType: "BalanceByMoneyType",
      fiscalCounterCurrency: "USD",
      fiscalCounterMoneyType: "Card",
      fiscalCounterValue: 115,
    },
    {
      fiscalCounterType: "BalanceByMoneyType",
      fiscalCounterCurrency: "USD",
      fiscalCounterMoneyType: "Cash",
      fiscalCounterValue: 115,
    },
    {
      fiscalCounterType: "SaleByTax",
      fiscalCounterCurrency: "USD",
      fiscalCounterTaxID: 513,
      fiscalCounterTaxPercent: 0,
      fiscalCounterValue: 230,
    },
    {
      fiscalCounterType: "SaleTaxByTax",
      fiscalCounterCurrency: "USD",
      fiscalCounterTaxID: 513,
      fiscalCounterTaxPercent: 0,
      fiscalCounterValue: 0, // must be excluded
    },
  ];

  it("orders counters by type priority then money-type enum order (Cash before Card)", () => {
    const s = fiscalDaySigningString(37367, 3, "2026-07-29", counters);
    assert.equal(
      s,
      "3736732026-07-29" +
        "SALEBYTAXUSD0.0023000" +
        "BALANCEBYMONEYTYPEUSDCASH11500" +
        "BALANCEBYMONEYTYPEUSDCARD11500",
    );
  });

  it("excludes zero-value counters", () => {
    const s = fiscalDaySigningString(37367, 3, "2026-07-29", counters);
    assert.ok(!s.includes("SALETAXBYTAX"));
  });

  it("handles an empty day", () => {
    assert.equal(fiscalDaySigningString(10626, 17, "2024-09-02", []), "10626172024-09-02");
  });
});

describe("sha256Base64", () => {
  it("matches a known vector", () => {
    // echo -n "abc" | openssl dgst -sha256 -binary | base64
    assert.equal(sha256Base64("abc"), "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });
});

describe("p1363ToDer", () => {
  it("wraps r and s as ASN.1 integers", () => {
    const r = Buffer.alloc(32, 1);
    const s = Buffer.alloc(32, 2);
    const der = p1363ToDer(Buffer.concat([r, s]));
    assert.equal(der[0], 0x30);
    assert.equal(der[1], der.length - 2);
    assert.equal(der[2], 0x02);
  });

  it("prepends 0x00 when the high bit is set", () => {
    const r = Buffer.alloc(32, 0xff);
    const s = Buffer.alloc(32, 1);
    const der = p1363ToDer(Buffer.concat([r, s]));
    // r integer: 02 21 00 ff...
    assert.equal(der[2], 0x02);
    assert.equal(der[3], 33);
    assert.equal(der[4], 0x00);
  });

  it("strips redundant leading zeros", () => {
    const r = Buffer.concat([Buffer.alloc(31, 0), Buffer.from([0x05])]);
    const s = Buffer.alloc(32, 1);
    const der = p1363ToDer(Buffer.concat([r, s]));
    assert.equal(der[3], 1); // r encodes as single byte 0x05
    assert.equal(der[4], 0x05);
  });
});

describe("signCanonicalString", () => {
  it("produces a DER signature that verifies against the public key", async () => {
    const { privateKeyPem, publicKeyPem } = await generateDeviceCsr("TEST01", 1);
    const sig = await signCanonicalString(new PemSigner(privateKeyPem), "hello fdms", "der");

    assert.equal(sig.hash, sha256Base64("hello fdms"));
    const der = Buffer.from(sig.signature, "base64");
    assert.equal(der[0], 0x30); // ASN.1 SEQUENCE

    // Convert DER back to P1363 and verify with WebCrypto.
    const p1363 = derToP1363(der);
    const spki = Buffer.from(
      publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, ""),
      "base64",
    );
    const key = await webcrypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      p1363,
      Buffer.from("hello fdms", "utf-8"),
    );
    assert.equal(ok, true);
  });
});

describe("deviceCommonName", () => {
  it("pads the device id to 10 digits", () => {
    assert.equal(deviceCommonName("GOKOSDK001", 37367), "ZIMRA-GOKOSDK001-0000037367");
  });
});

describe("receiptQrData", () => {
  it("matches the live-validated format", () => {
    // Reproduces the QR that ZIMRA's portal validated on 2026-07-29.
    const qr = receiptQrData({
      qrUrl: "https://fdmstest.zimra.co.zw",
      deviceId: 37367,
      receiptDate: new Date(2026, 6, 29, 10, 27, 30),
      receiptGlobalNo: 5,
      deviceSignatureBase64: Buffer.from("test-signature").toString("base64"),
    });
    assert.match(
      qr,
      /^https:\/\/fdmstest\.zimra\.co\.zw\/0000037367290720260000000005[0-9a-f]{16}$/,
    );
  });
});

describe("buildReceiptTaxes", () => {
  it("computes inclusive VAT and groups by tax", () => {
    const lines: ReceiptLine[] = [
      line(1, 115, 515, 15.5),
      line(2, 231, 515, 15.5),
      line(3, 10, 1, null),
    ];
    const taxes = buildReceiptTaxes(lines, true);
    assert.equal(taxes.length, 2);
    const exempt = taxes[0]!;
    const vat = taxes[1]!;
    assert.equal(exempt.taxID, 1);
    assert.equal(exempt.taxAmount, 0);
    assert.equal(exempt.salesAmountWithTax, 10);
    assert.equal(vat.taxID, 515);
    assert.equal(vat.salesAmountWithTax, 346);
    // 346 - 346/1.155 = 46.43
    assert.equal(vat.taxAmount, 46.43);
  });

  it("computes exclusive VAT", () => {
    const taxes = buildReceiptTaxes([line(1, 100, 515, 15.5)], false);
    assert.equal(taxes[0]!.taxAmount, 15.5);
    assert.equal(taxes[0]!.salesAmountWithTax, 115.5);
  });
});

describe("accumulateCounters", () => {
  it("accumulates sale, tax and balance counters across receipts", () => {
    const counters: FiscalDayCounter[] = [];
    accumulateCounters(counters, receipt("FiscalInvoice", 115, "Cash"));
    accumulateCounters(counters, receipt("FiscalInvoice", 115, "Cash"));
    const sale = counters.find((c) => c.fiscalCounterType === "SaleByTax");
    const bal = counters.find((c) => c.fiscalCounterType === "BalanceByMoneyType");
    assert.equal(sale?.fiscalCounterValue, 230);
    assert.equal(bal?.fiscalCounterValue, 230);
    assert.equal(bal?.fiscalCounterMoneyType, "Cash");
  });

  it("credit notes subtract", () => {
    const counters: FiscalDayCounter[] = [];
    accumulateCounters(counters, receipt("CreditNote", 50, "Cash"));
    const credit = counters.find((c) => c.fiscalCounterType === "CreditNoteByTax");
    const bal = counters.find((c) => c.fiscalCounterType === "BalanceByMoneyType");
    assert.equal(credit?.fiscalCounterValue, -50);
    assert.equal(bal?.fiscalCounterValue, -50);
  });
});

// -- helpers ----------------------------------------------------------------

function line(no: number, total: number, taxId: number, percent: number | null): ReceiptLine {
  return {
    receiptLineType: "Sale",
    receiptLineNo: no,
    receiptLineName: `line ${no}`,
    receiptLinePrice: total,
    receiptLineQuantity: 1,
    receiptLineTotal: total,
    taxPercent: percent,
    taxID: taxId,
  };
}

function receipt(
  type: Receipt["receiptType"],
  amount: number,
  money: "Cash" | "Card",
): Receipt {
  return {
    receiptType: type,
    receiptCurrency: "USD",
    receiptCounter: 1,
    receiptGlobalNo: 1,
    invoiceNo: "X",
    receiptDate: "2026-07-29T10:00:00",
    receiptLinesTaxInclusive: true,
    receiptLines: [],
    receiptTaxes: [
      { taxID: 513, taxPercent: 0, taxAmount: 0, salesAmountWithTax: amount },
    ],
    receiptPayments: [{ moneyTypeCode: money, paymentAmount: amount }],
    receiptTotal: amount,
    receiptDeviceSignature: { hash: "", signature: "" },
  };
}

function derToP1363(der: Buffer): Buffer {
  let i = 2;
  const readInt = (): Buffer => {
    i++; // 0x02
    const len = der[i++]!;
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > 32) v = v.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  return Buffer.concat([readInt(), readInt()]);
}
