#!/usr/bin/env node
// Fiscalise invoices kept in Excel.
//
// Reads a CSV saved from Excel (one row per invoice line), submits one fiscal
// receipt per invoice through the zimra-fdms CLI, and writes a results CSV
// with the receipt ID, global number, total and QR data for each invoice.
//
//   node excel-fiscalise.mjs sales.csv results.csv [--profile ./.zimra]
//
// Invoices already marked OK in results.csv are skipped, so running the same
// sheet twice never fiscalises an invoice twice. New results are appended.
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

// Excel on Windows saves "CSV UTF-8" with a byte-order mark.
const [header, ...rows] = parseCsv(readFileSync(input, "utf-8").replace(/^﻿/, ""));
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
for (const name of ["InvoiceNo", "Item", "Qty", "UnitPrice", "VAT", "Payment", "Currency"]) {
  if (col[name] === undefined) {
    console.error(`${input} has no "${name}" column. Expected: InvoiceNo, Item, Qty, UnitPrice, VAT, Payment, Currency.`);
    process.exit(1);
  }
}

// Invoices fiscalised on an earlier run.
const done = new Set();
if (existsSync(output)) {
  for (const r of parseCsv(readFileSync(output, "utf-8")).slice(1)) {
    if (r[1] === "OK") done.add(r[0]);
  }
} else {
  writeFileSync(output, "InvoiceNo,Status,ReceiptID,GlobalNo,Total,QRData,Error\n");
}

// Group lines by invoice number, keeping sheet order.
const invoices = new Map();
for (const [n, r] of rows.entries()) {
  const get = (name) => (r[col[name]] ?? "").trim();
  const no = get("InvoiceNo");
  if (!invoices.has(no)) {
    invoices.set(no, { no, payment: get("Payment"), currency: get("Currency"), lines: [], error: "" });
  }
  const inv = invoices.get(no);
  const tax = TAX[get("VAT").toLowerCase()];
  if (!tax) inv.error ||= `row ${n + 2}: unknown VAT "${get("VAT")}" (use 15, 0 or exempt)`;
  inv.lines.push({ name: get("Item"), quantity: Number(get("Qty")), price: Number(get("UnitPrice")), ...tax });
}

const work = mkdtempSync(join(tmpdir(), "zimra-excel-"));
let ok = 0;
let failed = 0;
let skipped = 0;
try {
  for (const inv of invoices.values()) {
    if (done.has(inv.no)) {
      skipped++;
      continue;
    }
    const record = (fields) => appendFileSync(output, fields.map(csvField).join(",") + "\n");
    if (inv.error) {
      failed++;
      record([inv.no, "FAILED", "", "", "", "", inv.error]);
      continue;
    }
    // Lines are tax inclusive, so the payment is the sum of line totals.
    const cents = inv.lines.reduce((s, l) => s + Math.round(l.price * l.quantity * 100), 0);
    const receipt = {
      receiptType: "FiscalInvoice",
      currency: inv.currency,
      invoiceNo: inv.no,
      linesTaxInclusive: true,
      lines: inv.lines,
      payments: [{ moneyType: inv.payment, amount: cents / 100 }],
    };
    const file = join(work, "receipt.json");
    writeFileSync(file, JSON.stringify(receipt));
    try {
      const out = execFileSync(
        cmd,
        [...cmdArgs, "submit", file, "--json", ...(profile ? ["--profile", profile] : [])],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" },
      );
      const res = JSON.parse(out);
      ok++;
      record([inv.no, "OK", res.receiptID, res.receiptGlobalNo, res.total, res.qrData, ""]);
    } catch (e) {
      failed++;
      const msg = String(e.stderr || e.stdout || e.message).trim().split("\n")[0];
      record([inv.no, "FAILED", "", "", "", "", msg]);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`${ok} fiscalised, ${failed} failed, ${skipped} already done. Results in ${output}`);
process.exit(failed ? 2 : 0);
