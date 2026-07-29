/**
 * Recover a FiscalDayCloseFailed day: re-sign the counters the server reports
 * and retry CloseDay. Usage: npx tsx scripts/recover-close.ts [p1363|der] [receiptCounter]
 */
import { readFileSync } from "node:fs";
import { FdmsHttpClient } from "../src/http.js";
import {
  fiscalDaySigningString,
  signCanonicalString,
  type EcdsaSignatureFormat,
} from "../src/signing.js";
import { toCents } from "../src/signing.js";
import type {
  CloseDayRequest,
  CloseDayResponse,
  GetStatusResponse,
} from "../src/types.js";

const format = (process.argv[2] ?? "der") as EcdsaSignatureFormat;
const receiptCounterArg = process.argv[3] ? Number(process.argv[3]) : undefined;

const device = {
  deviceId: 37367,
  serialNumber: "GOKOSDK001",
  modelName: "Server",
  modelVersion: "v1",
};
const identity = {
  certificatePem: readFileSync("secrets/device-certificate.pem", "utf-8"),
  privateKeyPem: readFileSync("secrets/device-private-key.pem", "utf-8"),
};

const http = new FdmsHttpClient(device, identity, { environment: "test" });

const status = await http.request<GetStatusResponse>(
  "GET",
  `/Device/v1/${device.deviceId}/GetStatus`,
);
console.log(
  `Status: ${status.fiscalDayStatus}, day ${status.lastFiscalDayNo}, error: ${status.fiscalDayClosingErrorCode ?? "none"}`,
);
console.log(`Server counters: ${JSON.stringify(status.fiscalDayCounter ?? [], null, 1)}`);

if (
  status.fiscalDayStatus !== "FiscalDayCloseFailed" &&
  status.fiscalDayStatus !== "FiscalDayCloseInitiated" &&
  status.fiscalDayStatus !== "FiscalDayOpened"
) {
  console.log("Day is closed — nothing to recover.");
  process.exit(0);
}

const fiscalDayNo = status.lastFiscalDayNo!;
const counters = (status.fiscalDayCounter ?? []).filter(
  (c) => toCents(c.fiscalCounterValue) !== 0,
);
// Fiscal day date: the day it was opened — today in this test flow.
const now = new Date();
const p = (n: number) => String(n).padStart(2, "0");
const fiscalDayDate = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

const receiptCounter =
  receiptCounterArg ??
  (status.fiscalDayDocumentQuantities ?? []).reduce(
    (sum: number, q: any) => sum + (q.receiptQuantity ?? 0),
    0,
  );

const canonical = fiscalDaySigningString(
  device.deviceId,
  fiscalDayNo,
  fiscalDayDate,
  counters,
);
console.log(`Canonical: ${canonical}`);
console.log(`Signature format: ${format}, receiptCounter: ${receiptCounter}`);

const signature = await signCanonicalString(
  identity.privateKeyPem,
  canonical,
  format,
);

const body: CloseDayRequest = {
  fiscalDayNo,
  fiscalDayCounters: counters,
  fiscalDayDeviceSignature: signature,
  receiptCounter,
};

const res = await http.request<CloseDayResponse>(
  "POST",
  `/Device/v1/${device.deviceId}/CloseDay`,
  body,
);
console.log(`CloseDay accepted — operationID ${res.operationID}`);

for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = await http.request<GetStatusResponse>(
    "GET",
    `/Device/v1/${device.deviceId}/GetStatus`,
  );
  console.log(`  status: ${s.fiscalDayStatus} ${s.fiscalDayClosingErrorCode ?? ""}`);
  if (s.fiscalDayStatus === "FiscalDayClosed") {
    console.log("RECOVERED — day closed.");
    process.exit(0);
  }
  if (s.fiscalDayStatus === "FiscalDayCloseFailed" && i > 0) {
    console.log("Still failing.");
    process.exit(1);
  }
}
process.exit(1);
