#!/usr/bin/env node
/**
 * zimra-fdms CLI — fiscalise from the terminal.
 *
 *   zimra-fdms register --device-id 12345 --serial ABC001 --activation-key XXXXXXXX
 *   zimra-fdms status
 *   zimra-fdms day open
 *   zimra-fdms submit receipt.json
 *   zimra-fdms day close
 *
 * State model: a CLI process dies between invocations, but FDMS's receipt hash
 * chain and fiscal-day counters must not. Everything lives in a profile
 * directory (default ./.zimra, override with --profile or ZIMRA_PROFILE):
 *
 *   device.json              device identity + environment
 *   device-certificate.pem   mTLS certificate issued by FDMS
 *   device-private-key.pem   matching private key (never leaves this machine)
 *   day-state.json           open fiscal day: counters, hash chain, receipt nos
 */

import { parseArgs } from "node:util";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { FiscalDevice, type FiscalDayState, type ReceiptInput } from "./device.js";
import { registerDevice } from "./registration.js";
import { FdmsHttpClient } from "./http.js";
import {
  fiscalDaySigningString,
  signCanonicalString,
  toCents,
} from "./signing.js";
import {
  FdmsApiError,
  type DeviceIdentity,
  type FdmsEnvironment,
  type GetStatusResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

interface Profile {
  dir: string;
  device: DeviceIdentity & { environment: FdmsEnvironment };
  certificatePem: string;
  privateKeyPem: string;
}

function profileDir(flag?: string): string {
  return resolve(flag ?? process.env.ZIMRA_PROFILE ?? ".zimra");
}

function loadProfile(flag?: string): Profile {
  const dir = profileDir(flag);
  const devicePath = join(dir, "device.json");
  if (!existsSync(devicePath)) {
    fail(
      `No device profile at ${devicePath}.\n` +
        `Run \`zimra-fdms register\` first, or point --profile (or ZIMRA_PROFILE) at an existing profile directory.`,
    );
  }
  const device = JSON.parse(readFileSync(devicePath, "utf-8"));
  for (const k of ["deviceId", "serialNumber", "modelName", "modelVersion", "environment"]) {
    if (device[k] === undefined) fail(`${devicePath} is missing "${k}".`);
  }
  return {
    dir,
    device,
    certificatePem: readProfileFile(dir, "device-certificate.pem"),
    privateKeyPem: readProfileFile(dir, "device-private-key.pem"),
  };
}

function readProfileFile(dir: string, name: string): string {
  const p = join(dir, name);
  if (!existsSync(p)) fail(`Missing ${p} — the profile is incomplete. Re-run \`zimra-fdms register\`.`);
  return readFileSync(p, "utf-8");
}

function fiscalDeviceFrom(p: Profile): FiscalDevice {
  return new FiscalDevice(
    p.device,
    { certificatePem: p.certificatePem, privateKeyPem: p.privateKeyPem },
    { environment: p.device.environment },
  );
}

// -- day state --------------------------------------------------------------

interface PersistedDayState {
  deviceId: number;
  savedAt: string;
  state: FiscalDayState;
}

function dayStatePath(dir: string): string {
  return join(dir, "day-state.json");
}

function loadDayState(p: Profile): FiscalDayState | undefined {
  const path = dayStatePath(p.dir);
  if (!existsSync(path)) return undefined;
  const persisted: PersistedDayState = JSON.parse(readFileSync(path, "utf-8"));
  if (persisted.deviceId !== p.device.deviceId) {
    fail(
      `${path} belongs to device ${persisted.deviceId}, but this profile is device ${p.device.deviceId}. Delete the stale file to continue.`,
    );
  }
  return persisted.state;
}

function saveDayState(p: Profile, state: FiscalDayState): void {
  const persisted: PersistedDayState = {
    deviceId: p.device.deviceId,
    savedAt: new Date().toISOString(),
    state,
  };
  writeFileSync(dayStatePath(p.dir), `${JSON.stringify(persisted, null, 2)}\n`);
}

function clearDayState(p: Profile): void {
  rmSync(dayStatePath(p.dir), { force: true });
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function printApiError(err: unknown): never {
  if (err instanceof FdmsApiError) {
    const lines = [err.message];
    if (err.hint) lines.push(`hint: ${err.hint}`);
    if (err.operationId) lines.push(`operationID: ${err.operationId}`);
    fail(lines.join("\n"));
  }
  if (err instanceof Error) fail(err.message);
  fail(String(err));
}

function money(n: number): string {
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const HELP = `zimra-fdms — ZIMRA FDMS fiscalisation from the terminal

Usage: zimra-fdms <command> [options]

Commands:
  register     Register a device and save its certificate to the profile
  status       Show device + fiscal day status
  ping         Ping FDMS (also reports the server's view of operating mode)
  config       Show taxpayer info, tax table and certificate expiry
  day open     Open a fiscal day
  day close    Close the fiscal day (recovers from server counters if needed)
  submit       Submit a receipt from a JSON file (see: submit --sample)

Global options:
  --profile <dir>   Profile directory (default ./.zimra, env ZIMRA_PROFILE)
  --json            Machine-readable output (status/config/submit)
  -h, --help        Help for a command
  -v, --version     Print version

Quickstart:
  zimra-fdms register --device-id 12345 --serial MYPOS01 --activation-key AAAABBBB
  zimra-fdms day open
  zimra-fdms submit --sample > receipt.json   # edit taxes to match: zimra-fdms config
  zimra-fdms submit receipt.json
  zimra-fdms day close
`;

const SAMPLE_RECEIPT: ReceiptInput = {
  receiptType: "FiscalInvoice",
  currency: "USD",
  invoiceNo: "INV-0001",
  linesTaxInclusive: true,
  lines: [
    {
      name: "Bread",
      price: 2.5,
      quantity: 2,
      taxId: 1,
      taxPercent: 15,
      taxCode: "A",
    },
  ],
  payments: [{ moneyType: "Cash", amount: 5.0 }],
};

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  );
  return pkg.version;
}

async function cmdRegister(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "device-id": { type: "string" },
      serial: { type: "string" },
      "activation-key": { type: "string" },
      "model-name": { type: "string", default: "Server" },
      "model-version": { type: "string", default: "v1" },
      env: { type: "string", default: "test" },
      profile: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: zimra-fdms register --device-id <n> --serial <sn> --activation-key <key>
       [--model-name Server] [--model-version v1] [--env test|production]
       [--profile <dir>] [--force]

Registers the device with FDMS (generates ECDSA P-256 keys + CSR) and writes
device.json, device-certificate.pem and device-private-key.pem to the profile.
Device ID, serial and activation key come from the FDMS taxpayer portal.`);
    return;
  }

  const deviceId = Number(values["device-id"]);
  if (!values["device-id"] || !Number.isInteger(deviceId) || deviceId <= 0) {
    fail("--device-id must be a positive integer (from the FDMS portal).");
  }
  if (!values.serial) fail("--serial is required (device serial number from the FDMS portal).");
  const activationKey = values["activation-key"];
  if (!activationKey || activationKey.length !== 8) {
    fail("--activation-key must be the 8-character key from the FDMS portal.");
  }
  const environment = values.env as FdmsEnvironment;
  if (environment !== "test" && environment !== "production") {
    fail(`--env must be "test" or "production", got "${values.env}".`);
  }

  const dir = profileDir(values.profile);
  const certPath = join(dir, "device-certificate.pem");
  if (existsSync(certPath) && !values.force) {
    fail(
      `${certPath} already exists. Registering again would invalidate the current certificate.\n` +
        `Use --force if you really mean to re-register (requires a fresh activation key).`,
    );
  }

  const device: DeviceIdentity = {
    deviceId,
    serialNumber: values.serial,
    modelName: values["model-name"]!,
    modelVersion: values["model-version"]!,
  };

  console.log(`Registering device ${deviceId} (${device.serialNumber}) against FDMS ${environment}...`);
  try {
    const result = await registerDevice(device, activationKey, { environment });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "device.json"), `${JSON.stringify({ ...device, environment }, null, 2)}\n`);
    writeFileSync(certPath, result.certificatePem);
    const keyPath = join(dir, "device-private-key.pem");
    writeFileSync(keyPath, result.keys.privateKeyPem);
    try {
      chmodSync(keyPath, 0o600); // no-op on Windows, meaningful elsewhere
    } catch {
      /* best effort */
    }
    console.log(`OK — certificate issued (operationID ${result.operationId}).`);
    console.log(`Profile written to ${dir}`);
    console.log(`Keep ${keyPath} secret — it signs your receipts.`);
  } catch (err) {
    printApiError(err);
  }
}

async function cmdStatus(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: zimra-fdms status [--profile <dir>] [--json]");
    return;
  }
  const p = loadProfile(values.profile);
  try {
    const s = await fiscalDeviceFrom(p).getStatus();
    if (values.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    console.log(`Device ${p.device.deviceId} (${p.device.serialNumber}) — ${p.device.environment}`);
    console.log(`Fiscal day:   ${s.fiscalDayStatus}${s.lastFiscalDayNo != null ? ` (day ${s.lastFiscalDayNo})` : ""}`);
    if (s.fiscalDayClosingErrorCode) console.log(`Close error:  ${s.fiscalDayClosingErrorCode}`);
    console.log(`Last receipt: global no ${s.lastReceiptGlobalNo ?? 0}`);
    const local = loadDayState(p);
    if (local) {
      console.log(
        `Local state:  day ${local.fiscalDayNo}, ${local.receiptCounter} receipt(s) this day (${dayStatePath(p.dir)})`,
      );
    } else if (s.fiscalDayStatus === "FiscalDayOpened") {
      console.log(
        `Local state:  none — day was opened elsewhere. \`day close\` will recover from server counters.`,
      );
    }
  } catch (err) {
    printApiError(err);
  }
}

async function cmdPing(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: zimra-fdms ping [--profile <dir>]");
    return;
  }
  const p = loadProfile(values.profile);
  try {
    const start = Date.now();
    const res = await fiscalDeviceFrom(p).ping();
    const freq =
      res.reportingFrequency != null ? `, reporting frequency ${res.reportingFrequency} min` : "";
    console.log(`OK — ${Date.now() - start}ms${freq}`);
  } catch (err) {
    printApiError(err);
  }
}

async function cmdConfig(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: zimra-fdms config [--profile <dir>] [--json]");
    return;
  }
  const p = loadProfile(values.profile);
  try {
    const c = await fiscalDeviceFrom(p).getConfig();
    if (values.json) {
      console.log(JSON.stringify(c, null, 2));
      return;
    }
    console.log(`Taxpayer:      ${c.taxPayerName} (TIN ${c.taxPayerTIN}${c.vatNumber ? `, VAT ${c.vatNumber}` : ""})`);
    console.log(`Branch:        ${c.deviceBranchName}`);
    console.log(`Operating:     ${c.deviceOperatingMode}, max day length ${c.taxPayerDayMaxHrs}h`);
    console.log(`Cert expires:  ${c.certificateValidTill}`);
    console.log(`Taxes (use taxId/taxPercent in receipts):`);
    for (const t of c.applicableTaxes) {
      const pct = t.taxPercent == null ? "exempt" : `${t.taxPercent}%`;
      console.log(`  taxId ${t.taxID}  ${pct.padEnd(7)}  ${t.taxName}`);
    }
  } catch (err) {
    printApiError(err);
  }
}

async function cmdDayOpen(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: zimra-fdms day open [--profile <dir>]");
    return;
  }
  const p = loadProfile(values.profile);
  const device = fiscalDeviceFrom(p);
  try {
    const res = await device.openDay();
    saveDayState(p, device.getState()!);
    console.log(`Fiscal day ${res.fiscalDayNo} opened.`);
  } catch (err) {
    printApiError(err);
  }
}

async function cmdDayClose(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: zimra-fdms day close [--profile <dir>]

Closes the fiscal day using the locally tracked counters. If no local day
state exists (day opened on another machine, or state file lost), falls back
to signing the counters FDMS itself reports — same math, server's numbers.`);
    return;
  }
  const p = loadProfile(values.profile);
  const device = fiscalDeviceFrom(p);
  const local = loadDayState(p);

  try {
    if (local) {
      device.restoreState(local);
      await device.closeDay();
    } else {
      const already = await closeFromServerCounters(p);
      if (already) {
        clearDayState(p);
        return;
      }
    }
    clearDayState(p);
    const outcome = await pollDayClosed(p);
    if (outcome === "FiscalDayClosed") {
      console.log("Fiscal day closed.");
    } else {
      fail(
        `CloseDay was accepted but the day is now "${outcome}". Check \`zimra-fdms status\` — FDMS validates asynchronously.`,
      );
    }
  } catch (err) {
    printApiError(err);
  }
}

/**
 * Stateless close: sign whatever counters the server reports. This is the
 * recovery path for a lost/absent day-state.json and mirrors what the server
 * expects bit-for-bit, since the numbers are its own.
 */
async function closeFromServerCounters(p: Profile): Promise<boolean> {
  const http = new FdmsHttpClient(
    p.device,
    { certificatePem: p.certificatePem, privateKeyPem: p.privateKeyPem },
    { environment: p.device.environment },
  );
  const status = await http.request<GetStatusResponse>(
    "GET",
    http.devicePath("GetStatus"),
  );
  if (status.fiscalDayStatus === "FiscalDayClosed") {
    console.log("Fiscal day is already closed.");
    return true;
  }
  const fiscalDayNo = status.lastFiscalDayNo;
  if (fiscalDayNo == null) fail("Server did not report a fiscal day number.");

  const counters = (status.fiscalDayCounter ?? []).filter(
    (c) => toCents(c.fiscalCounterValue) !== 0,
  );
  const receiptCounter = (status.fiscalDayDocumentQuantities ?? []).reduce(
    (sum, q) => sum + (q.receiptQuantity ?? 0),
    0,
  );
  // GetStatus doesn't report when the day was opened; the signing string needs
  // the opening date. Same-day recovery (the realistic case) makes that today.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fiscalDayDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  console.log(
    `No local day state — closing day ${fiscalDayNo} from server counters (${counters.length} counter(s), ${receiptCounter} receipt(s)).`,
  );
  const canonical = fiscalDaySigningString(
    p.device.deviceId,
    fiscalDayNo,
    fiscalDayDate,
    counters,
  );
  const signature = await signCanonicalString(p.privateKeyPem, canonical, "der");
  await http.request("POST", http.devicePath("CloseDay"), {
    fiscalDayNo,
    fiscalDayCounters: counters,
    fiscalDayDeviceSignature: signature,
    receiptCounter,
  });
  return false;
}

/** CloseDay is asynchronous server-side; poll until it settles. */
async function pollDayClosed(p: Profile): Promise<string> {
  const device = fiscalDeviceFrom(p);
  let last = "FiscalDayCloseInitiated";
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await device.getStatus();
    last = s.fiscalDayStatus;
    if (last === "FiscalDayClosed" || last === "FiscalDayCloseFailed") break;
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return last;
}

async function cmdSubmit(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      json: { type: "boolean", default: false },
      sample: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: zimra-fdms submit <receipt.json> [--profile <dir>] [--json]
       zimra-fdms submit --sample     # print a starter receipt JSON

The file is a ReceiptInput: lines (price/quantity/taxId/taxPercent), payments
(moneyType/amount), currency, invoiceNo. Valid taxIds: \`zimra-fdms config\`.
Payments must sum to the receipt total.`);
    return;
  }
  if (values.sample) {
    console.log(JSON.stringify(SAMPLE_RECEIPT, null, 2));
    return;
  }
  const file = positionals[0];
  if (!file) fail("Usage: zimra-fdms submit <receipt.json> (or --sample for a template).");
  if (!existsSync(file)) fail(`${file} not found.`);

  let input: ReceiptInput;
  try {
    input = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    fail(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  for (const k of ["currency", "invoiceNo", "lines", "payments"] as const) {
    if (input[k] === undefined) fail(`${file} is missing "${k}". See \`zimra-fdms submit --sample\`.`);
  }

  const p = loadProfile(values.profile);
  const local = loadDayState(p);
  if (!local) {
    fail(
      `No open fiscal day in this profile. Run \`zimra-fdms day open\` first.\n` +
        `(If the day was opened elsewhere, receipts must come from the machine holding the hash chain.)`,
    );
  }

  const device = fiscalDeviceFrom(p);
  device.restoreState(local);
  try {
    await device.getConfig(); // for QR data
    const res = await device.submitReceipt(input);
    saveDayState(p, device.getState()!);

    const validation = res.response.validationErrors ?? [];
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            receiptCounter: res.receipt.receiptCounter,
            receiptGlobalNo: res.receipt.receiptGlobalNo,
            receiptID: res.response.receiptID,
            total: res.receipt.receiptTotal,
            qrData: res.qrData,
            validationErrors: validation,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `Receipt ${res.receipt.receiptCounter} (global no ${res.receipt.receiptGlobalNo}) accepted — total ${money(res.receipt.receiptTotal)} ${res.receipt.receiptCurrency}, receiptID ${res.response.receiptID}.`,
      );
      if (res.qrData) console.log(`QR data: ${res.qrData}`);
      if (validation.length) {
        console.log(`Server validation warnings:`);
        for (const v of validation) {
          console.log(`  [${v.validationErrorColor ?? "?"}] ${v.validationErrorCode}`);
        }
      }
    }
  } catch (err) {
    printApiError(err);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(version());
    return;
  }

  switch (cmd) {
    case "register":
      return cmdRegister(rest);
    case "status":
      return cmdStatus(rest);
    case "ping":
      return cmdPing(rest);
    case "config":
      return cmdConfig(rest);
    case "day": {
      const sub = rest[0];
      if (sub === "open") return cmdDayOpen(rest.slice(1));
      if (sub === "close") return cmdDayClose(rest.slice(1));
      fail(`Usage: zimra-fdms day <open|close> — got "${sub ?? ""}".`);
      break;
    }
    case "submit":
      return cmdSubmit(rest);
    default:
      fail(`Unknown command "${cmd}". Run \`zimra-fdms --help\` for usage.`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  printApiError(err);
});
