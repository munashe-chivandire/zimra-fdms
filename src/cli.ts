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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DayNotClosableError, type ReceiptInput } from "./device.js";
import { registerDevice } from "./registration.js";
import {
  ProfileError,
  clearDayState,
  closeFromServerCounters,
  dayStatePath,
  fiscalDeviceFrom,
  loadDayState,
  loadLastGlobalNo,
  loadProfile as loadProfileOrThrow,
  pollDayClosed,
  profileDir,
  saveDayState,
  writeProfile,
  type Profile,
} from "./profile.js";
import { FdmsApiError, type DeviceIdentity, type FdmsEnvironment } from "./types.js";

function loadProfile(flag?: string): Profile {
  try {
    return loadProfileOrThrow(flag);
  } catch (err) {
    if (err instanceof ProfileError) fail(err.message);
    throw err;
  }
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
  mcp          Run the MCP server over stdio (for Claude Code and other agents)

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
    const { keyPath } = writeProfile(
      dir,
      { ...device, environment },
      result.certificatePem,
      result.keys.privateKeyPem,
    );
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
    const res = await device.openDay(undefined, new Date(), {
      lastReceiptGlobalNo: loadLastGlobalNo(p),
    });
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
      date: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: zimra-fdms day close [--profile <dir>] [--date YYYY-MM-DD] [--force]

Closes the fiscal day using the locally tracked counters. If no local day
state exists (day opened on another machine, or state file lost), falls back
to signing the counters FDMS itself reports — same math, server's numbers.

The signature covers the date the day was OPENED. Without local state the SDK
cannot know it (FDMS does not report it) and assumes today. Pass --date when
recovering a day opened on an earlier date.

Local state is kept until FDMS confirms the close, so a failed close can be
retried with the real counters.

A day holding a receipt with a Red validation error (e.g. RCPT030) cannot be
closed by the device; FDMS rejects it with ReceiptsWithValidationErrors and
only ZIMRA can close it. The command refuses up front; --force submits anyway.`);
    return;
  }
  const p = loadProfile(values.profile);
  const device = fiscalDeviceFrom(p);
  const local = loadDayState(p);

  try {
    if (local) {
      device.restoreState(local);
      await device.closeDay({ force: values.force });
    } else {
      const res = await closeFromServerCounters(p, { fiscalDayDate: values.date });
      if (res.alreadyClosed) {
        console.log("Fiscal day is already closed.");
        clearDayState(p);
        return;
      }
      console.log(
        `No local day state — closing day ${res.fiscalDayNo} from server counters (${res.counterCount} counter(s), ${res.receiptCounter} receipt(s), opened ${res.fiscalDayDate}).`,
      );
      if (res.assumedToday) {
        console.log(
          "Assuming the day was opened today. If it was opened earlier the close fails with BadCertificateSignature; retry with --date YYYY-MM-DD.",
        );
      }
    }
    const outcome = await pollDayClosed(p, () => process.stdout.write("."));
    process.stdout.write("\n");
    if (outcome === "FiscalDayClosed") {
      clearDayState(p);
      console.log("Fiscal day closed.");
    } else {
      const hint = local
        ? "Local day state was kept so you can retry."
        : values.date === undefined
          ? "If the day was opened on an earlier date, retry with --date YYYY-MM-DD."
          : "Check the opened date on the ZIMRA ops portal; a day with receipt validation errors can only be force-closed there.";
      fail(
        `CloseDay was accepted but the day is now "${outcome}". Check \`zimra-fdms status\` — FDMS validates asynchronously. ${hint}`,
      );
    }
  } catch (err) {
    if (err instanceof DayNotClosableError) {
      fail(
        `${err.message}
Test environment: https://fdmsops.zimra.co.zw/fdms-public/close-fiscal-day. Production: contact ZIMRA. Local day state was kept. Use --force to submit the close anyway.`,
      );
    }
    printApiError(err);
  }
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
  // JSON carries receiptDate as a string; the SDK wants a Date.
  if (input.receiptDate !== undefined) {
    const d = new Date(input.receiptDate as unknown as string);
    if (Number.isNaN(d.getTime())) fail(`${file}: receiptDate is not a valid date.`);
    input.receiptDate = d;
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
          console.log(
            `  [${v.validationErrorColor ?? "?"}] ${v.validationErrorCode}${v.validationErrorDescription ? ` — ${v.validationErrorDescription}` : ""}`,
          );
        }
      }
      if (device.getState()?.redErrors?.length) {
        console.error(
          "Red validation error: this fiscal day can no longer be closed by the device. Close it on the ZIMRA portal once trading is done.",
        );
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
    case "mcp": {
      const { runMcpStdio } = await import("./mcp.js");
      return runMcpStdio(rest);
    }
    default:
      fail(`Unknown command "${cmd}". Run \`zimra-fdms --help\` for usage.`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  printApiError(err);
});
