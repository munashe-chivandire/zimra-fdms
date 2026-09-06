#!/usr/bin/env node
/**
 * zimra-fdms-conformance: check any implementation against the published
 * vectors.
 *
 *   zimra-fdms-conformance [--vectors file.json] -- <command> [args...]
 *
 * For every vector the command is run once with one JSON object on stdin
 * and must print one JSON object on stdout:
 *
 *   {"kind":"receipt","deviceId":N,"receipt":{...},"previousReceiptHash":"..."|null}
 *     -> {"canonical":"...","hash":"...","signature":"base64 DER"?}
 *   {"kind":"fiscalDay","deviceId":N,"fiscalDayNo":N,"fiscalDayDate":"YYYY-MM-DD","counters":[...]}
 *     -> {"canonical":"...","hash":"...","signature":"..."?}
 *   {"kind":"qr","qrUrl":"...","deviceId":N,"receiptDate":"...","receiptGlobalNo":N,"deviceSignatureBase64":"..."}
 *     -> {"qrData":"..."}
 *   {"kind":"sha256","input":"..."}                         -> {"sha256Base64":"..."}
 *   {"kind":"taxes","lines":[...],"taxInclusive":true}     -> {"taxes":[...]}
 *
 * The private key is in the vectors file; an implementation that signs
 * gets its signature verified against the public key. One that does not
 * sign leaves the field out and is checked on formatting only.
 *
 * dist/conformance/reference.js is a responder built on this SDK; start
 * from it when porting.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromBase64, pemToDer, utf8Bytes } from "../core/bytes.js";
import { derToP1363 } from "../core/signer.js";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep === -1 ? argv : argv.slice(0, sep);
const command = sep === -1 ? [] : argv.slice(sep + 1);
let vectorsPath = fileURLToPath(new URL("../../vectors/zimra-fdms-vectors.json", import.meta.url));
for (let i = 0; i < opts.length; i++) {
  if (opts[i] === "--vectors") vectorsPath = opts[++i]!;
  if (opts[i] === "--help" || opts[i] === "-h") {
    console.log("usage: zimra-fdms-conformance [--vectors file.json] -- <command> [args...]");
    process.exit(0);
  }
}
if (command.length === 0) {
  console.error("usage: zimra-fdms-conformance [--vectors file.json] -- <command> [args...]");
  process.exit(2);
}

const vectors = JSON.parse(readFileSync(vectorsPath, "utf-8"));
const publicKey = await webcrypto.subtle.importKey(
  "spki",
  new Uint8Array(pemToDer(vectors.publicKeyPem)),
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["verify"],
);

let pass = 0;
let fail = 0;
const failures: string[] = [];

function run(input: unknown): Record<string, unknown> {
  const res = spawnSync(command[0]!, command.slice(1), { input: JSON.stringify(input), encoding: "utf-8" });
  if (res.status !== 0) throw new Error(`command exited ${res.status}: ${res.stderr.trim()}`);
  try {
    return JSON.parse(res.stdout.trim());
  } catch {
    throw new Error(`stdout is not JSON: ${res.stdout.slice(0, 200)}`);
  }
}

async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${label}`);
  } catch (e) {
    fail++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${label}: ${msg}`);
    console.log(`  FAIL ${label}\n       ${msg}`);
  }
}

function expectEqual(what: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

async function verify(canonical: string, signatureB64: unknown) {
  if (typeof signatureB64 !== "string") return;
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    new Uint8Array(derToP1363(fromBase64(signatureB64))),
    new Uint8Array(utf8Bytes(canonical)),
  );
  if (!ok) throw new Error("signature does not verify against publicKeyPem (is it ASN.1 DER over SHA-256 of the canonical string?)");
}

console.log(`vectors ${vectorsPath} (version ${vectors.version})`);
console.log(`command ${command.join(" ")}\n`);

console.log("sha256");
for (const v of vectors.sha256) {
  await check(JSON.stringify(v.input).slice(0, 40), () => {
    expectEqual("sha256Base64", run({ kind: "sha256", input: v.input }).sha256Base64, v.sha256Base64);
  });
}

console.log("taxes");
for (const v of vectors.taxes) {
  await check(v.name, () => {
    expectEqual("taxes", run({ kind: "taxes", lines: v.lines, taxInclusive: v.taxInclusive }).taxes, v.expected);
  });
}

console.log("receipts");
for (const v of vectors.receipts) {
  await check(v.name, async () => {
    const out = run({ kind: "receipt", deviceId: v.deviceId, receipt: v.receipt, previousReceiptHash: v.previousReceiptHash });
    expectEqual("canonical string", out.canonical, v.canonical);
    expectEqual("hash", out.hash, v.hash);
    await verify(v.canonical, out.signature);
  });
}

console.log("fiscal days");
for (const v of vectors.fiscalDays) {
  await check(v.name, async () => {
    const out = run({ kind: "fiscalDay", deviceId: v.deviceId, fiscalDayNo: v.fiscalDayNo, fiscalDayDate: v.fiscalDayDate, counters: v.counters });
    expectEqual("canonical string", out.canonical, v.canonical);
    expectEqual("hash", out.hash, v.hash);
    await verify(v.canonical, out.signature);
  });
}

console.log("qr");
for (const v of vectors.qr) {
  await check(v.name, () => {
    const { expected, name, ...input } = v;
    void name;
    expectEqual("qrData", run({ kind: "qr", ...input }).qrData, expected);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
