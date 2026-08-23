/**
 * CLI tests — spawn the compiled bin (dist/cli.js) exactly as npx would run
 * it, and assert on exit codes, stdout and stderr. Everything here is offline:
 * commands that would touch FDMS are only exercised up to their local
 * validation (missing profile, bad flags, existing certificate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");

function run(args: string[], opts: { cwd?: string } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ZIMRA_PROFILE: undefined },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function tempProfile(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "zimra-cli-test-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const DEVICE_JSON = JSON.stringify({
  deviceId: 99999,
  serialNumber: "TEST001",
  modelName: "Server",
  modelVersion: "v1",
  environment: "test",
});

// -- global flags -----------------------------------------------------------

test("--version prints the package version", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  const { code, stdout } = run(["--version"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), pkg.version);
});

test("--help lists every command", () => {
  const { code, stdout } = run(["--help"]);
  assert.equal(code, 0);
  for (const cmd of ["register", "status", "ping", "config", "day open", "day close", "submit"]) {
    assert.ok(stdout.includes(cmd), `help should mention "${cmd}"`);
  }
});

test("no arguments shows help and exits 0", () => {
  const { code, stdout } = run([]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Usage:"));
});

test("unknown command exits 1 with a pointer to --help", () => {
  const { code, stderr } = run(["fiscalize-everything"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("fiscalize-everything"));
  assert.ok(stderr.includes("--help"));
});

test("day without open/close exits 1", () => {
  const { code, stderr } = run(["day", "sideways"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("open|close"));
});

// -- sample receipt ---------------------------------------------------------

test("submit --sample emits valid, internally consistent JSON", () => {
  const { code, stdout } = run(["submit", "--sample"]);
  assert.equal(code, 0);
  const receipt = JSON.parse(stdout);
  assert.ok(Array.isArray(receipt.lines) && receipt.lines.length > 0);
  assert.ok(Array.isArray(receipt.payments) && receipt.payments.length > 0);
  assert.equal(typeof receipt.currency, "string");
  assert.equal(typeof receipt.invoiceNo, "string");
  // Payments must equal the line totals or FDMS rejects it — keep the sample honest.
  const lineTotal = receipt.lines.reduce(
    (s: number, l: any) => s + l.price * l.quantity,
    0,
  );
  const payTotal = receipt.payments.reduce((s: number, p: any) => s + p.amount, 0);
  assert.equal(Math.round(lineTotal * 100), Math.round(payTotal * 100));
});

// -- profile handling -------------------------------------------------------

test("status without a profile fails with guidance", () => {
  const dir = tempProfile(); // empty dir, no device.json
  const { code, stderr } = run(["status", "--profile", dir]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("No device profile"));
  assert.ok(stderr.includes("register"));
  rmSync(dir, { recursive: true, force: true });
});

test("incomplete profile (device.json but no cert) fails clearly", () => {
  const dir = tempProfile({ "device.json": DEVICE_JSON });
  const { code, stderr } = run(["status", "--profile", dir]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("device-certificate.pem"));
  rmSync(dir, { recursive: true, force: true });
});

test("device.json missing a field fails naming the field", () => {
  const dir = tempProfile({
    "device.json": JSON.stringify({ deviceId: 1, serialNumber: "X" }),
  });
  const { code, stderr } = run(["status", "--profile", dir]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("modelName"));
  rmSync(dir, { recursive: true, force: true });
});

// -- submit local validation ------------------------------------------------

test("submit with no file argument exits 1", () => {
  const { code, stderr } = run(["submit"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("--sample"));
});

test("submit with a missing file exits 1", () => {
  const { code, stderr } = run(["submit", "no-such-receipt.json"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("no-such-receipt.json"));
});

test("submit with invalid JSON exits 1 before touching the network", () => {
  const dir = tempProfile({ "broken.json": "{not json" });
  const { code, stderr } = run(["submit", join(dir, "broken.json")]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("not valid JSON"));
  rmSync(dir, { recursive: true, force: true });
});

test("submit with missing required receipt fields names the field", () => {
  const dir = tempProfile({
    "partial.json": JSON.stringify({ currency: "USD", invoiceNo: "1" }),
  });
  const { code, stderr } = run(["submit", join(dir, "partial.json")]);
  assert.equal(code, 1);
  assert.ok(stderr.includes(`"lines"`));
  rmSync(dir, { recursive: true, force: true });
});

// -- register local validation ----------------------------------------------

test("register without --device-id exits 1", () => {
  const { code, stderr } = run(["register", "--serial", "X", "--activation-key", "AAAABBBB"]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("--device-id"));
});

test("register with non-numeric --device-id exits 1", () => {
  const { code, stderr } = run([
    "register", "--device-id", "twelve", "--serial", "X", "--activation-key", "AAAABBBB",
  ]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("--device-id"));
});

test("register with a wrong-length activation key exits 1", () => {
  const { code, stderr } = run([
    "register", "--device-id", "123", "--serial", "X", "--activation-key", "SHORT",
  ]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("8-character"));
});

test("register with a bogus --env exits 1", () => {
  const { code, stderr } = run([
    "register", "--device-id", "123", "--serial", "X",
    "--activation-key", "AAAABBBB", "--env", "staging",
  ]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("test"));
  assert.ok(stderr.includes("production"));
});

test("register refuses to clobber an existing certificate without --force", () => {
  const dir = tempProfile({ "device-certificate.pem": "EXISTING CERT" });
  const { code, stderr } = run([
    "register", "--device-id", "123", "--serial", "X",
    "--activation-key", "AAAABBBB", "--profile", dir,
  ]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("--force"));
  // and the cert must be untouched
  assert.equal(readFileSync(join(dir, "device-certificate.pem"), "utf-8"), "EXISTING CERT");
  rmSync(dir, { recursive: true, force: true });
});

// -- day-state safety -------------------------------------------------------

test("day state from a different device is rejected", () => {
  const dir = tempProfile({
    "device.json": DEVICE_JSON,
    "device-certificate.pem": "PEM",
    "device-private-key.pem": "PEM",
    "day-state.json": JSON.stringify({
      deviceId: 11111, // wrong device
      savedAt: new Date().toISOString(),
      state: {
        fiscalDayNo: 1, fiscalDayDate: "2026-01-01", receiptCounter: 0,
        receiptGlobalNo: 0, counters: [],
      },
    }),
  });
  // `submit` reads day state after file validation but before the network.
  const receipt = tempProfile({
    "r.json": JSON.stringify({ currency: "USD", invoiceNo: "1", lines: [], payments: [] }),
  });
  const { code, stderr } = run(["submit", join(receipt, "r.json"), "--profile", dir]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("11111"));
  assert.ok(stderr.includes("99999"));
  rmSync(dir, { recursive: true, force: true });
  rmSync(receipt, { recursive: true, force: true });
});

test("submit without an open day points at `day open`", () => {
  const dir = tempProfile({
    "device.json": DEVICE_JSON,
    "device-certificate.pem": "PEM",
    "device-private-key.pem": "PEM",
  });
  const receipt = tempProfile({
    "r.json": JSON.stringify({ currency: "USD", invoiceNo: "1", lines: [], payments: [] }),
  });
  const { code, stderr } = run(["submit", join(receipt, "r.json"), "--profile", dir]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("day open"));
  rmSync(dir, { recursive: true, force: true });
  rmSync(receipt, { recursive: true, force: true });
});

test("day close --help documents --date and the kept state", () => {
  const { code, stdout } = run(["day", "close", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("--date YYYY-MM-DD"));
  assert.ok(stdout.includes("kept until FDMS confirms"));
});
