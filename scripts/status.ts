import { readFileSync } from "node:fs";
import { FdmsClient } from "../src/core/transport.js";
import { NodeTransport } from "../src/node/transport.js";
const http = new FdmsClient(
  { deviceId: 37367, serialNumber: "GOKOSDK001", modelName: "Server", modelVersion: "v1" },
  new NodeTransport({ certificatePem: readFileSync("secrets/device-certificate.pem", "utf-8"), privateKeyPem: readFileSync("secrets/device-private-key.pem", "utf-8") }),
  { environment: "test" });
const s = await http.request("GET", "/Device/v1/37367/GetStatus");
console.log(JSON.stringify(s, null, 1));
