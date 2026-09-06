#!/usr/bin/env node
/**
 * zimra-fdms-simulator: run a local FDMS from the command line.
 *
 *   npx zimra-fdms-simulator --port 8443 --ca ./sim-ca.pem
 *
 * Then point the SDK or the CLI at it:
 *
 *   ZIMRA_BASE_URL=https://localhost:8443 ZIMRA_CA=./sim-ca.pem zimra-fdms register ...
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { FdmsSimulator } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8443" },
    host: { type: "string", default: "127.0.0.1" },
    ca: { type: "string", short: "c", default: "zimra-simulator-ca.pem" },
    "activation-key": { type: "string", multiple: true },
    "close-delay": { type: "string", default: "300" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`zimra-fdms-simulator: a local FDMS with real mutual TLS.

Options
  --port <n>              Listen port (default 8443)
  --host <addr>           Bind address (default 127.0.0.1)
  --ca <file>             Where to write the CA certificate (default zimra-simulator-ca.pem)
  --activation-key <key>  Accept only these keys for RegisterDevice (repeatable; default any 8 chars)
  --close-delay <ms>      Time before CloseDay settles (default 300)

The SDK needs the CA to trust the server:
  new FiscalDevice(id, pems, { baseUrl: "https://localhost:8443", ca: readFileSync("zimra-simulator-ca.pem", "utf-8") })
The CLI reads ZIMRA_BASE_URL and ZIMRA_CA.`);
  process.exit(0);
}

const sim = await FdmsSimulator.create({
  port: Number(values.port),
  host: values.host,
  activationKeys: values["activation-key"],
  closeDelayMs: Number(values["close-delay"]),
});
const { url, caPem } = await sim.start();
writeFileSync(values.ca!, caPem);
console.log(`FDMS simulator listening at ${url}`);
console.log(`CA certificate written to ${values.ca}`);
console.log(`Register with any 8-character activation key${values["activation-key"] ? ` from: ${values["activation-key"].join(", ")}` : ""}.`);
console.log(`Replays: RCPT010 RCPT011 RCPT012 RCPT013 RCPT014 RCPT020 RCPT021 RCPT030 RCPT031, async CloseDay, BadCertificateSignature, ReceiptsWithValidationErrors.`);

const stop = () => void sim.stop().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
