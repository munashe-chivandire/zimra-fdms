/**
 * Live end-to-end test against the FDMS TEST environment:
 * GetConfig → GetStatus → OpenDay → SubmitReceipt ×2 (hash-chained) → CloseDay.
 */
import { readFileSync } from "node:fs";
import { FiscalDevice } from "../src/index.js";

const device = {
  deviceId: 37367,
  serialNumber: "GOKOSDK001",
  modelName: "Server",
  modelVersion: "v1",
};

const fd = new FiscalDevice(
  device,
  {
    certificatePem: readFileSync("secrets/device-certificate.pem", "utf-8"),
    privateKeyPem: readFileSync("secrets/device-private-key.pem", "utf-8"),
  },
  { environment: "test", signatureFormat: "der" },
);

console.log("1) GetConfig (proves mTLS with the issued certificate)...");
const config = await fd.getConfig();
console.log(`   OK — taxpayer: ${config.taxPayerName} (TIN ${config.taxPayerTIN})`);
console.log(`   qrUrl: ${config.qrUrl}, operating mode: ${config.deviceOperatingMode}`);
console.log(`   applicable taxes:`);
for (const t of config.applicableTaxes) {
  console.log(`     taxID ${t.taxID}: ${t.taxName} ${t.taxPercent ?? "(exempt)"}`);
}

console.log("2) GetStatus...");
const status = await fd.getStatus();
console.log(
  `   OK — day status: ${status.fiscalDayStatus}, lastFiscalDayNo: ${status.lastFiscalDayNo}, lastReceiptGlobalNo: ${status.lastReceiptGlobalNo}`,
);

if (status.fiscalDayStatus !== "FiscalDayClosed") {
  console.log("   Day already open — closing it first is manual; aborting.");
  process.exit(1);
}

console.log("3) OpenDay...");
const day = await fd.openDay();
console.log(`   OK — fiscalDayNo: ${day.fiscalDayNo}`);

// Pick real tax IDs from config: standard rate + exempt if present.
const taxes = config.applicableTaxes;
const standard =
  taxes.find((t) => (t.taxPercent ?? 0) > 0) ?? taxes[0]!;
const exempt = taxes.find((t) => t.taxPercent === null || t.taxPercent === undefined);

console.log(
  `4) SubmitReceipt #1 (standard rate ${standard.taxPercent}%, taxID ${standard.taxID})...`,
);
const runId = Date.now().toString(36).toUpperCase();
const r1 = await fd.submitReceipt({
  currency: "USD",
  invoiceNo: `GOKO-${runId}-1`,
  lines: [
    {
      name: "Consulting services",
      price: 115.0,
      quantity: 1,
      taxId: standard.taxID,
      taxPercent: standard.taxPercent,
    },
  ],
  payments: [{ moneyType: "Cash", amount: 115.0 }],
});
console.log(
  `   OK — receiptID: ${r1.response.receiptID}, validationErrors: ${JSON.stringify(r1.response.validationErrors ?? [])}`,
);
console.log(`   QR data: ${r1.qrData}`);

console.log("5) SubmitReceipt #2 (chained to #1's hash)...");
const r2 = await fd.submitReceipt({
  currency: "USD",
  invoiceNo: `GOKO-${runId}-2`,
  lines: [
    {
      name: "Training workshop",
      price: 57.5,
      quantity: 2,
      taxId: standard.taxID,
      taxPercent: standard.taxPercent,
    },
    ...(exempt
      ? [
          {
            name: "Exempt booklet",
            price: 10.0,
            quantity: 1,
            taxId: exempt.taxID,
            taxPercent: null,
          },
        ]
      : []),
  ],
  payments: [{ moneyType: "Card", amount: 57.5 * 2 + (exempt ? 10 : 0) }],
});
console.log(
  `   OK — receiptID: ${r2.response.receiptID}, validationErrors: ${JSON.stringify(r2.response.validationErrors ?? [])}`,
);

console.log("6) CloseDay (signed counters)...");
const closed = await fd.closeDay();
console.log(`   OK — operationID: ${closed.operationID}`);

console.log("7) Verify closure via GetStatus...");
let final = await fd.getStatus();
for (let i = 0; i < 10 && final.fiscalDayStatus === "FiscalDayCloseInitiated"; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  final = await fd.getStatus();
}
console.log(
  `   Final day status: ${final.fiscalDayStatus}` +
    (final.fiscalDayClosingErrorCode
      ? ` — closing error: ${final.fiscalDayClosingErrorCode}`
      : ""),
);

if (final.fiscalDayStatus !== "FiscalDayClosed") {
  process.exit(1);
}
console.log("E2E PASSED");
