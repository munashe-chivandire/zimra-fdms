/**
 * Provoke RCPT031 (future receipt date) then RCPT030 (date not after previous)
 * on the TEST device, print the exact validation errors FDMS returns, then
 * try to close the day so we know whether these poison it.
 */
import { readFileSync } from "node:fs";
import { FiscalDevice } from "../src/index.js";

const fd = new FiscalDevice(
  { deviceId: 37367, serialNumber: "GOKOSDK001", modelName: "Server", modelVersion: "v1" },
  {
    certificatePem: readFileSync("secrets/device-certificate.pem", "utf-8"),
    privateKeyPem: readFileSync("secrets/device-private-key.pem", "utf-8"),
  },
  { environment: "test", signatureFormat: "der" },
);

const line = { name: "Probe", price: 1, quantity: 1, taxId: 513, taxPercent: 0 };
const pay = [{ moneyType: "Cash" as const, amount: 1 }];
const errs = (r: any) => JSON.stringify(r.response.validationErrors ?? []);

const status = await fd.getStatus();
if (status.fiscalDayStatus !== "FiscalDayClosed") { console.log("day not closed:", status.fiscalDayStatus); process.exit(1); }
const day = await fd.openDay();
console.log(`day ${day.fiscalDayNo} opened`);

const future = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2h
const r1 = await fd.submitReceipt({ currency: "USD", invoiceNo: "PROBE-1", lines: [line], payments: pay, receiptDate: future });
console.log(`1) future date (+2h): global ${r1.receipt.receiptGlobalNo} -> ${errs(r1)}`);

const r2 = await fd.submitReceipt({ currency: "USD", invoiceNo: "PROBE-2", lines: [line], payments: pay, receiptDate: new Date() });
console.log(`2) now (before previous): global ${r2.receipt.receiptGlobalNo} -> ${errs(r2)}`);

const r3 = await fd.submitReceipt({ currency: "USD", invoiceNo: "PROBE-3", lines: [line], payments: pay });
console.log(`3) auto-nudged (prev+1s): global ${r3.receipt.receiptGlobalNo} -> ${errs(r3)}`);

await fd.closeDay();
let s = await fd.getStatus();
for (let i = 0; i < 12 && s.fiscalDayStatus === "FiscalDayCloseInitiated"; i++) {
  await new Promise((r) => setTimeout(r, 3000)); s = await fd.getStatus();
}
console.log(`close -> ${s.fiscalDayStatus} ${s.fiscalDayClosingErrorCode ?? ""}`);
