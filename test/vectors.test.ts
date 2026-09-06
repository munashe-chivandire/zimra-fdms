/**
 * The SDK against its own published vectors, and the conformance runner
 * against the reference responder. If a signing rule changes, this is what
 * breaks first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

import { receiptSigningString, fiscalDaySigningString, concatenateReceiptTaxes } from "../src/core/signing.js";
import { sha256Base64 } from "../src/core/sha256.js";
import { buildReceiptTaxes } from "../src/core/device.js";
import { receiptQrData } from "../src/core/qr.js";
import { derToP1363 } from "../src/core/signer.js";
import { fromBase64, pemToDer, utf8Bytes } from "../src/core/bytes.js";

const vectorsPath = new URL("../vectors/zimra-fdms-vectors.json", import.meta.url);
const vectors = JSON.parse(readFileSync(vectorsPath, "utf-8"));

async function verify(canonical: string, signature: string): Promise<boolean> {
  const key = await webcrypto.subtle.importKey("spki", new Uint8Array(pemToDer(vectors.publicKeyPem)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(derToP1363(fromBase64(signature))), new Uint8Array(utf8Bytes(canonical)));
}

describe("published vectors", () => {
  it("sha256", () => {
    for (const v of vectors.sha256) assert.equal(sha256Base64(v.input), v.sha256Base64);
  });
  it("taxes", () => {
    for (const v of vectors.taxes) assert.deepEqual(buildReceiptTaxes(v.lines, v.taxInclusive), v.expected, v.name);
  });
  it("receipt canonical strings, hashes and signatures", async () => {
    for (const v of vectors.receipts) {
      assert.equal(concatenateReceiptTaxes(v.receipt.receiptTaxes), v.taxBlock, v.name);
      const canonical = receiptSigningString(v.deviceId, v.receipt, v.previousReceiptHash ?? undefined);
      assert.equal(canonical, v.canonical, v.name);
      assert.equal(sha256Base64(canonical), v.hash, v.name);
      assert.equal(await verify(canonical, v.signature), true, v.name);
    }
  });
  it("fiscal day canonical strings, hashes and signatures", async () => {
    for (const v of vectors.fiscalDays) {
      const canonical = fiscalDaySigningString(v.deviceId, v.fiscalDayNo, v.fiscalDayDate, v.counters);
      assert.equal(canonical, v.canonical, v.name);
      assert.equal(sha256Base64(canonical), v.hash, v.name);
      assert.equal(await verify(canonical, v.signature), true, v.name);
    }
  });
  it("qr data", () => {
    for (const v of vectors.qr) {
      assert.equal(receiptQrData({ ...v, receiptDate: new Date(v.receiptDate) }), v.expected, v.name);
    }
  });
  it("pins the first live-verified receipt canonical string", () => {
    // Receipt 24 on device 37367, accepted by the FDMS test environment on 2026-09-06.
    assert.equal(vectors.receipts[0].canonical, "37367FISCALINVOICEUSD242026-09-06T12:18:391150015.00150011500");
  });
});

describe("conformance runner", () => {
  it("passes against the reference responder, with signatures", () => {
    const keyPath = fileURLToPath(new URL("../vectors/test-key.pem", import.meta.url));
    const res = spawnSync(
      process.execPath,
      ["dist/conformance/cli.js", "--", process.execPath, "dist/conformance/reference.js"],
      { encoding: "utf-8", env: { ...process.env, ZIMRA_VECTOR_KEY: keyPath } },
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /0 failed/);
    assert.doesNotMatch(res.stdout, /FAIL/);
  });

  it("fails a responder that gets the tax block wrong", () => {
    const bad = `process.stdin.on("data",()=>{}).on("end",()=>{process.stdout.write(JSON.stringify({canonical:"x",hash:"y",sha256Base64:"z",taxes:[],qrData:"q"}))})`;
    const res = spawnSync(process.execPath, ["dist/conformance/cli.js", "--", process.execPath, "-e", bad], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /FAIL/);
  });
});
