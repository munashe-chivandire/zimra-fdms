/**
 * zimra-fdms MCP server — fiscalise from an agent.
 *
 *   zimra-fdms mcp [--profile <dir>]
 *
 * Built on the MCP 2026-07-28 spec via @modelcontextprotocol/server v2:
 * the same server factory serves modern (stateless) and 2025-era clients,
 * and every tool is self-describing — the profile directory travels as an
 * explicit tool argument (or ZIMRA_PROFILE), never as session state. The
 * durable state FDMS actually cares about (hash chain, day counters) lives
 * in the profile directory on disk, exactly as the CLI leaves it, so agent
 * and terminal can be used interchangeably against one device.
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { type ReceiptInput } from "./device.js";
import { registerDevice } from "./registration.js";
import {
  ProfileError,
  clearDayState,
  closeFromServerCounters,
  fiscalDeviceFrom,
  loadDayState,
  loadProfile,
  pollDayClosed,
  profileDir,
  saveDayState,
  writeProfile,
} from "./profile.js";
import { FdmsApiError, type FdmsEnvironment } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const profileArg = z
  .string()
  .optional()
  .describe(
    "Profile directory holding the device identity, certificate and day state (default: $ZIMRA_PROFILE or ./.zimra)",
  );

const receiptLineSchema = z.object({
  name: z.string().describe("Item name as it appears on the receipt"),
  price: z.number().describe("Unit price (tax-inclusive if linesTaxInclusive)"),
  quantity: z.number(),
  taxId: z.number().int().describe("Tax ID from the device tax table (see get_config)"),
  taxPercent: z
    .number()
    .nullish()
    .describe("Percent for taxed lines; omit/null for exempt lines"),
  taxCode: z.string().optional(),
  hsCode: z.string().optional(),
});

const receiptInputSchema = z.object({
  receiptType: z
    .enum(["FiscalInvoice", "CreditNote", "DebitNote"])
    .optional()
    .describe("Default FiscalInvoice"),
  currency: z.string().describe('ISO currency code, e.g. "USD" or "ZWG"'),
  invoiceNo: z.string().describe("Your own invoice number, unique per device"),
  linesTaxInclusive: z.boolean().optional().describe("Default true"),
  lines: z.array(receiptLineSchema).min(1),
  payments: z
    .array(
      z.object({
        moneyType: z.enum([
          "Cash",
          "Card",
          "MobileWallet",
          "Coupon",
          "Credit",
          "BankTransfer",
          "Other",
        ]),
        amount: z.number(),
      }),
    )
    .min(1)
    .describe("Must sum to the receipt total"),
  notes: z.string().optional(),
  buyer: z
    .object({
      buyerRegisterName: z.string().optional(),
      buyerTradeName: z.string().optional(),
      vatNumber: z.string().optional(),
      buyerTIN: z.string().optional(),
      buyerContacts: z
        .object({ phoneNo: z.string().optional(), email: z.string().optional() })
        .optional(),
    })
    .optional(),
  creditDebitNote: z
    .object({
      receiptID: z.number().nullish(),
      deviceID: z.number().nullish(),
      receiptGlobalNo: z.number().nullish(),
      fiscalDayNo: z.number().nullish(),
    })
    .optional()
    .describe("Required for CreditNote/DebitNote: reference to the original receipt"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: Record<string, unknown>, summary?: string): ToolResult {
  return {
    content: [{ type: "text", text: summary ?? JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(err: unknown): ToolResult {
  const lines: string[] = [];
  if (err instanceof FdmsApiError) {
    lines.push(err.message);
    if (err.hint) lines.push(`hint: ${err.hint}`);
    if (err.operationId) lines.push(`operationID: ${err.operationId}`);
  } else if (err instanceof Error) {
    lines.push(err.message);
  } else {
    lines.push(String(err));
  }
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

/** Wraps a handler so FDMS/profile failures surface as in-band tool errors. */
function handling<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      if (
        err instanceof FdmsApiError ||
        err instanceof ProfileError ||
        err instanceof Error
      ) {
        return toolError(err);
      }
      throw err;
    }
  };
}

const SAMPLE_RECEIPT: ReceiptInput = {
  receiptType: "FiscalInvoice",
  currency: "USD",
  invoiceNo: "INV-0001",
  linesTaxInclusive: true,
  lines: [
    { name: "Bread", price: 2.5, quantity: 2, taxId: 1, taxPercent: 15, taxCode: "A" },
  ],
  payments: [{ moneyType: "Cash", amount: 5.0 }],
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createZimraMcpServer(defaultProfile?: string): McpServer {
  const version: string = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ).version;
  const server = new McpServer(
    { name: "zimra-fdms", version },
    { capabilities: { tools: {} } },
  );

  const dirOf = (profile?: string) => profileDir(profile ?? defaultProfile);
  const load = (profile?: string) => loadProfile(profile ?? defaultProfile);

  server.registerTool(
    "register_device",
    {
      title: "Register FDMS device",
      description:
        "Register a device with ZIMRA FDMS: generates ECDSA P-256 keys and a CSR, exchanges the activation key for an mTLS certificate, and writes the profile directory. Device ID, serial number and activation key come from the FDMS taxpayer portal. Refuses to overwrite an existing certificate unless force is set — re-registering invalidates the current certificate and needs a fresh activation key.",
      inputSchema: z.object({
        deviceId: z.number().int().positive().describe("Device ID from the FDMS portal"),
        serialNumber: z.string().describe("Device serial number from the FDMS portal"),
        activationKey: z.string().length(8).describe("8-character activation key"),
        modelName: z.string().default("Server"),
        modelVersion: z.string().default("v1"),
        environment: z.enum(["test", "production"]).default("test"),
        force: z.boolean().default(false).describe("Overwrite an existing certificate"),
        profile: profileArg,
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    handling(async (args) => {
      const dir = dirOf(args.profile);
      const certPath = join(dir, "device-certificate.pem");
      if (existsSync(certPath) && !args.force) {
        return toolError(
          new ProfileError(
            `${certPath} already exists. Registering again would invalidate the current certificate. Pass force: true only if you really mean to re-register (requires a fresh activation key).`,
          ),
        );
      }
      const device = {
        deviceId: args.deviceId,
        serialNumber: args.serialNumber,
        modelName: args.modelName,
        modelVersion: args.modelVersion,
      };
      const environment = args.environment as FdmsEnvironment;
      const result = await registerDevice(device, args.activationKey, { environment });
      const { keyPath } = writeProfile(
        dir,
        { ...device, environment },
        result.certificatePem,
        result.keys.privateKeyPem,
      );
      return ok(
        { operationId: result.operationId, profileDir: dir, keyPath },
        `Certificate issued (operationID ${result.operationId}). Profile written to ${dir}. Keep ${keyPath} secret — it signs receipts.`,
      );
    }),
  );

  server.registerTool(
    "get_status",
    {
      title: "Device + fiscal day status",
      description:
        "Fetch the device's fiscal day status from FDMS (day open/closed, last fiscal day number, last global receipt number) plus the local day state if one exists in the profile.",
      inputSchema: z.object({ profile: profileArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handling(async (args) => {
      const p = load(args.profile);
      const s = await fiscalDeviceFrom(p).getStatus();
      const local = loadDayState(p);
      return ok({
        deviceId: p.device.deviceId,
        serialNumber: p.device.serialNumber,
        environment: p.device.environment,
        ...s,
        localDayState: local
          ? {
              fiscalDayNo: local.fiscalDayNo,
              receiptCounter: local.receiptCounter,
              receiptGlobalNo: local.receiptGlobalNo,
            }
          : null,
      });
    }),
  );

  server.registerTool(
    "ping",
    {
      title: "Ping FDMS",
      description:
        "Ping FDMS over mTLS. Confirms connectivity and the certificate, and reports the server-side reporting frequency.",
      inputSchema: z.object({ profile: profileArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handling(async (args) => {
      const p = load(args.profile);
      const start = Date.now();
      const res = await fiscalDeviceFrom(p).ping();
      return ok(
        { latencyMs: Date.now() - start, reportingFrequency: res.reportingFrequency ?? null },
        `OK — ${Date.now() - start}ms`,
      );
    }),
  );

  server.registerTool(
    "get_config",
    {
      title: "Taxpayer config + tax table",
      description:
        "Fetch taxpayer info, operating mode, certificate expiry and the applicable tax table. Use the taxID/taxPercent values from here when building receipt lines.",
      inputSchema: z.object({ profile: profileArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handling(async (args) => {
      const p = load(args.profile);
      const c = await fiscalDeviceFrom(p).getConfig();
      return ok({ ...c });
    }),
  );

  server.registerTool(
    "open_fiscal_day",
    {
      title: "Open fiscal day",
      description:
        "Open a fiscal day on the device and persist the local day state (hash chain, counters) to the profile. Receipts can only be submitted while a day is open.",
      inputSchema: z.object({ profile: profileArg }),
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    handling(async (args) => {
      const p = load(args.profile);
      const device = fiscalDeviceFrom(p);
      const res = await device.openDay();
      saveDayState(p, device.getState()!);
      return ok(
        { fiscalDayNo: res.fiscalDayNo },
        `Fiscal day ${res.fiscalDayNo} opened.`,
      );
    }),
  );

  server.registerTool(
    "close_fiscal_day",
    {
      title: "Close fiscal day",
      description:
        "Close the fiscal day using the locally tracked counters. If no local day state exists (day opened elsewhere or state lost), falls back to signing the counters FDMS itself reports. CloseDay is asynchronous server-side; this polls until the day settles (up to ~36s).",
      inputSchema: z.object({ profile: profileArg }),
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    handling(async (args) => {
      const p = load(args.profile);
      const local = loadDayState(p);
      let recovery: string | undefined;
      if (local) {
        const device = fiscalDeviceFrom(p);
        device.restoreState(local);
        await device.closeDay();
      } else {
        const res = await closeFromServerCounters(p);
        if (res.alreadyClosed) {
          clearDayState(p);
          return ok({ status: "FiscalDayClosed" }, "Fiscal day is already closed.");
        }
        recovery = `No local day state — closed day ${res.fiscalDayNo} from server counters (${res.counterCount} counter(s), ${res.receiptCounter} receipt(s)).`;
      }
      clearDayState(p);
      const outcome = await pollDayClosed(p);
      if (outcome === "FiscalDayClosed") {
        return ok(
          { status: outcome },
          ["Fiscal day closed.", recovery].filter(Boolean).join(" "),
        );
      }
      return toolError(
        new Error(
          `CloseDay was accepted but the day is now "${outcome}". Check get_status — FDMS validates asynchronously.`,
        ),
      );
    }),
  );

  server.registerTool(
    "submit_receipt",
    {
      title: "Submit fiscal receipt",
      description:
        "Sign and submit a receipt to FDMS on the open fiscal day, advancing the receipt hash chain and day counters in the profile. Requires an open fiscal day in this profile (the machine holding the hash chain). Valid taxId/taxPercent values come from get_config; payments must sum to the receipt total. Returns the receipt numbers, receiptID and QR data for printing.",
      inputSchema: z.object({
        receipt: receiptInputSchema,
        profile: profileArg,
      }),
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    handling(async (args) => {
      const p = load(args.profile);
      const local = loadDayState(p);
      if (!local) {
        return toolError(
          new ProfileError(
            "No open fiscal day in this profile. Call open_fiscal_day first. (If the day was opened elsewhere, receipts must come from the machine holding the hash chain.)",
          ),
        );
      }
      const device = fiscalDeviceFrom(p);
      device.restoreState(local);
      await device.getConfig(); // for QR data
      const res = await device.submitReceipt(args.receipt as ReceiptInput);
      saveDayState(p, device.getState()!);
      const validation = res.response.validationErrors ?? [];
      return ok(
        {
          receiptCounter: res.receipt.receiptCounter,
          receiptGlobalNo: res.receipt.receiptGlobalNo,
          receiptID: res.response.receiptID,
          total: res.receipt.receiptTotal,
          currency: res.receipt.receiptCurrency,
          qrData: res.qrData ?? null,
          validationErrors: validation,
        },
        `Receipt ${res.receipt.receiptCounter} (global no ${res.receipt.receiptGlobalNo}) accepted — total ${res.receipt.receiptTotal.toFixed(2)} ${res.receipt.receiptCurrency}, receiptID ${res.response.receiptID}.` +
          (validation.length
            ? ` Server validation warnings: ${validation
                .map((v) => `[${v.validationErrorColor ?? "?"}] ${v.validationErrorCode}`)
                .join(", ")}`
            : ""),
      );
    }),
  );

  server.registerTool(
    "sample_receipt",
    {
      title: "Sample receipt template",
      description:
        "Return a starter ReceiptInput template for submit_receipt. Adjust the taxes to match the device tax table from get_config before submitting.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok({ receipt: SAMPLE_RECEIPT }),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runMcpStdio(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: zimra-fdms mcp [--profile <dir>]

Runs the zimra-fdms MCP server over stdio (MCP 2026-07-28, with 2025-era
fallback). Add it to Claude Code with:

  claude mcp add zimra-fdms -- npx zimra-fdms mcp

Tools operate on a profile directory (--profile, ZIMRA_PROFILE, or ./.zimra),
the same one the CLI uses.`);
    return;
  }
  serveStdio(() => createZimraMcpServer(values.profile), {
    onerror: (err) => console.error(`mcp: ${err.message}`),
  });
}
