#!/usr/bin/env node
/**
 * Reference responder for zimra-fdms-conformance, built on this SDK. Reads
 * one request from stdin, writes one answer to stdout. Port this file to
 * your language to certify a port.
 */
import { readFileSync } from "node:fs";
import { receiptSigningString, fiscalDaySigningString } from "../core/signing.js";
import { sha256Base64 } from "../core/sha256.js";
import { buildReceiptTaxes } from "../core/device.js";
import { receiptQrData } from "../core/qr.js";
import { signCanonicalString } from "../core/signer.js";
import { PemSigner } from "../node/pem-signer.js";

const req = JSON.parse(readFileSync(0, "utf-8"));
const keyPath = process.env.ZIMRA_VECTOR_KEY;
const signer = keyPath ? new PemSigner(readFileSync(keyPath, "utf-8")) : undefined;

async function sign(canonical: string) {
  if (!signer) return { canonical, hash: sha256Base64(canonical) };
  const s = await signCanonicalString(signer, canonical, "der");
  return { canonical, hash: s.hash, signature: s.signature };
}

let out: unknown;
switch (req.kind) {
  case "sha256":
    out = { sha256Base64: sha256Base64(req.input) };
    break;
  case "taxes":
    out = { taxes: buildReceiptTaxes(req.lines, req.taxInclusive) };
    break;
  case "receipt":
    out = await sign(receiptSigningString(req.deviceId, req.receipt, req.previousReceiptHash ?? undefined));
    break;
  case "fiscalDay":
    out = await sign(fiscalDaySigningString(req.deviceId, req.fiscalDayNo, req.fiscalDayDate, req.counters));
    break;
  case "qr":
    out = { qrData: receiptQrData({ ...req, receiptDate: new Date(req.receiptDate) }) };
    break;
  default:
    console.error(`unknown kind ${req.kind}`);
    process.exit(2);
}
process.stdout.write(JSON.stringify(out));
