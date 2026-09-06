import { readFileSync } from "node:fs";
import { FdmsClient } from "../src/core/transport.js";
import { NodeTransport } from "../src/node/transport.js";
import { fdmsDateTime } from "../src/core/signing.js";
const http = new FdmsClient(
  { deviceId: 37367, serialNumber: "GOKOSDK001", modelName: "Server", modelVersion: "v1" },
  new NodeTransport({ certificatePem: readFileSync("secrets/device-certificate.pem", "utf-8"), privateKeyPem: readFileSync("secrets/device-private-key.pem", "utf-8") }),
  { environment: "test" });
try {
  const r = await http.request("POST", "/Device/v1/37367/OpenDay", { fiscalDayNo: null, fiscalDayOpened: fdmsDateTime() });
  console.log("OPENED:", JSON.stringify(r));
} catch (e: any) {
  console.log("OPEN FAILED:", e.status, e.message, JSON.stringify(e.problem));
}
