#!/usr/bin/env node
// Fiscalise invoices kept in Excel.
//
// Reads a CSV saved from Excel (one row per invoice line), submits one fiscal
// receipt per invoice through the zimra-fdms CLI, and writes a results CSV
// with the receipt ID, global number, total and QR data for each invoice.
//
//   node excel-fiscalise.mjs sales.csv results.csv [--profile ./.zimra]
//
// results.csv is a journal: a PENDING row is written before each submit and
// the outcome after it. The latest row per invoice decides what a rerun does:
//   OK       done, skipped
//   FAILED   FDMS did not take it, submitted again
//   PENDING  the run stopped mid-submit, skipped and reported for checking
//   UNKNOWN  sent but no answer, skipped and reported for checking
// So running a sheet twice, or after a crash, never fiscalises an invoice twice.
//
// Needs a registered device and an open fiscal day (see README.md).
// ZIMRA_CLI overrides the command used to run the CLI (default "npx zimra-fdms").
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const profile = flag("--profile");
const profileDir = profile ?? process.env.ZIMRA_PROFILE ?? ".zimra";
const [input, output] = args;
if (!input || !output) {
  console.error("Usage: node excel-fiscalise.mjs <sales.csv> <results.csv> [--profile <dir>]");
  process.exit(1);
}
const [cmd, ...cmdArgs] = (process.env.ZIMRA_CLI ?? "npx zimra-fdms").split(" ");

// Excel's VAT column mapped to the device's tax table. Check yours with
// `zimra-fdms config`: taxIds differ between taxpayers.
const TAX = {
  "15": { taxId: 1, taxPercent: 15, taxCode: "A" },
  "0": { taxId: 2, taxPercent: 0, taxCode: "B" },
  exempt: { taxId: 3, taxCode: "C" },
};

const HEADER = "InvoiceNo,Status,ReceiptID,GlobalNo,Total,QRData,Warnings,Error";

// Minimal RFC 4180 parser: Excel quotes any field containing a comma, quote
// or line break, and doubles quotes inside it.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const csvField = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const record = (fields) => appendFileSync(output, fields.map(csvField).join(",") + "\n");

// The invoice whose receipt the SDK signed and sent but never got an answer
// for. The next CLI call delivers it, so it must not be submitted again.
function pendingInvoice() {
  const file = join(profileDir, "pending-submit.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")).receipt?.invoiceNo;
  } catch {
    return undefined;
  }
}

// Excel on Windows saves "CSV UTF-8" with a byte-order mark.
const [header, ...rows] = parseCsv(readFileSync(input, "utf-8").replace(/^﻿/, ""));
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
for (const name of ["InvoiceNo", "Item", "Qty", "UnitPrice", "VAT", "Payment", "Currency"]) {
  if (col[name] === undefined) {
    console.error(`${input} has no "${name}" column. Expected: InvoiceNo, Item, Qty, UnitPrice, VAT, Payment, Currency.`);
    process.exit(1);
  }
}

// Latest status per invoice from earlier runs.
const status = new Map();
const existing = existsSync(output) ? readFileSync(output, "utf-8").replace(/^﻿/, "") : "";
if (existing.trim() === "") {
  writeFileSync(output, HEADER + "\n");
} else {
  const [h, ...done] = parseCsv(existing);
  if (h.join(",") !== HEADER) {
    console.error(`${output} is not a results file from this script (header: ${h.join(",")}). Use a new file name.`);
    process.exit(1);
  }
  for (const r of done) status.set(r[0], r[1]);
}

// Group lines by invoice number, keeping sheet order. Prices are checked as
// text so a blank or mistyped cell cannot become a zero-price line.
const invoices = new Map();
for (const [n, r] of rows.entries()) {
  const get = (name) => (r[col[name]] ?? "").trim();
  const at = `row ${n + 2}`;
  const no = get("InvoiceNo");
  if (!invoices.has(no)) {
    invoices.set(no, { no, payment: get("Payment"), currency: get("Currency"), lines: [], error: "" });
  }
  const inv = invoices.get(no);
  const fail = (msg) => (inv.error ||= `${at}: ${msg}`);
  if (!no) fail("InvoiceNo is blank");
  if (get("Payment") !== inv.payment) fail(`Payment "${get("Payment")}" differs from the invoice's first row ("${inv.payment}")`);
  if (get("Currency") !== inv.currency) fail(`Currency "${get("Currency")}" differs from the invoice's first row ("${inv.currency}")`);

  const tax = TAX[get("VAT").toLowerCase()];
  if (!tax) fail(`unknown VAT "${get("VAT")}" (use 15, 0 or exempt)`);
  const price = get("UnitPrice");
  if (!/^\d+(\.\d{1,2})?$/.test(price)) fail(`UnitPrice "${price}" must be a number with at most two decimals`);
  const qty = Number(get("Qty"));
  if (get("Qty") === "" || !Number.isFinite(qty) || qty <= 0) fail(`Qty "${get("Qty")}" must be a number above 0`);

  // Integer cents, rounded per line the same way the SDK does.
  const [whole, frac = ""] = price.split(".");
  const priceCents = Number(whole) * 100 + Number(frac.padEnd(2, "0") || 0);
  inv.lines.push({ name: get("Item"), quantity: qty, price: Number(price), lineCents: Math.round(priceCents * qty), ...tax });
}

const work = mkdtempSync(join(tmpdir(), "zimra-excel-"));
const count = { ok: 0, failed: 0, skipped: 0, red: 0, check: [] };
let stopped = false;
try {
  for (const inv of invoices.values()) {
    const prev = status.get(inv.no);
    if (prev === "OK") {
      count.skipped++;
      continue;
    }
    if (prev === "PENDING" || prev === "UNKNOWN") {
      count.check.push(inv.no);
      continue;
    }
    if (inv.error) {
      count.failed++;
      record([inv.no, "FAILED", "", "", "", "", "", inv.error]);
      continue;
    }
    const cents = inv.lines.reduce((s, l) => s + l.lineCents, 0);
    const receipt = {
      receiptType: "FiscalInvoice",
      currency: inv.currency,
      invoiceNo: inv.no,
      linesTaxInclusive: true,
      lines: inv.lines.map(({ lineCents, ...l }) => l),
      payments: [{ moneyType: inv.payment, amount: cents / 100 }],
    };
    const file = join(work, "receipt.json");
    writeFileSync(file, JSON.stringify(receipt));
    const cliArgs = [...cmdArgs, "submit", file, "--json", ...(profile ? ["--profile", profile] : [])];

    record([inv.no, "PENDING", "", "", "", "", "", ""]);
    try {
      const out = execFileSync(
        cmd,
        // Windows runs npx through cmd.exe, so quote anything with spaces.
        process.platform === "win32" ? cliArgs.map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)) : cliArgs,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" },
      );
      const res = JSON.parse(out);
      // Accepted with warnings is still accepted: never resubmit it.
      const warnings = (res.validationErrors ?? [])
        .map((v) => `${v.validationErrorColor ?? "?"} ${v.validationErrorCode}`)
        .join("; ");
      if (/\bRed\b/.test(warnings)) {
        count.red++;
        console.error(`${inv.no}: FDMS flagged a Red error (${warnings}). The device cannot close this day; close it on the ZIMRA portal.`);
      }
      count.ok++;
      record([inv.no, "OK", res.receiptID, res.receiptGlobalNo, res.total, res.qrData, warnings, ""]);
    } catch (e) {
      const msg = String(e.stderr || e.stdout || e.message).trim().split("\n")[0];
      if (pendingInvoice() === inv.no) {
        // Signed and sent, answer lost. Stop: the connection is likely down
        // and the next CLI call will deliver this receipt first.
        count.check.push(inv.no);
        record([inv.no, "UNKNOWN", "", "", "", "", "", msg]);
        stopped = true;
        break;
      }
      count.failed++;
      record([inv.no, "FAILED", "", "", "", "", "", msg]);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`${count.ok} fiscalised, ${count.failed} failed, ${count.skipped} already done. Results in ${output}`);
if (stopped) console.log("Stopped early: FDMS did not answer. Run again once the connection is back.");
if (count.check.length) {
  console.log(
    `Check before retrying: ${count.check.join(", ")}. These may already be fiscalised. ` +
      `Confirm on the FDMS portal, then append a row marking each OK, or FAILED to submit it again.`,
  );
}
process.exit(count.failed || count.red || count.check.length ? 2 : 0);
