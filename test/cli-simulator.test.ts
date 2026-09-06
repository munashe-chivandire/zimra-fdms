/**
 * The compiled CLI driven end to end against the simulator through
 * ZIMRA_BASE_URL and ZIMRA_CA: register, open, submit, close, with the
 * profile directory doubling as the device's FileStorage.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FdmsSimulator } from "../src/simulator/server.js";

const CLI = join(process.cwd(), "dist", "node", "cli.js");
let sim: FdmsSimulator;
let dir: string;
let env: NodeJS.ProcessEnv;

// The simulator lives in this process, so the CLI must run asynchronously
// or the event loop it needs to answer with is blocked.
function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: dir });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("CLI against the simulator", () => {
  before(async () => {
    sim = await FdmsSimulator.create({ closeDelayMs: 20 });
    const { url, caPem } = await sim.start();
    dir = mkdtempSync(join(tmpdir(), "zimra-cli-sim-"));
    writeFileSync(join(dir, "ca.pem"), caPem);
    env = { ...process.env, ZIMRA_BASE_URL: url, ZIMRA_CA: join(dir, "ca.pem"), ZIMRA_PROFILE: join(dir, "profile") };
  });
  after(async () => {
    await sim.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers, opens, submits with a decimal price, and closes", async () => {
    const reg = await cli("register", "--device-id", "900", "--serial", "CLISIM01", "--activation-key", "ABCD1234");
    assert.equal(reg.code, 0, reg.out);
    assert.ok(existsSync(join(dir, "profile", "device-certificate.pem")));

    const status = await cli("status", "--json");
    assert.equal(status.code, 0, status.out);
    assert.equal(JSON.parse(status.out).fiscalDayStatus, "FiscalDayClosed");

    const open = await cli("day", "open");
    assert.equal(open.code, 0, open.out);
    assert.ok(existsSync(join(dir, "profile", "day-state.json")));

    writeFileSync(
      join(dir, "receipt.json"),
      JSON.stringify({
        currency: "USD",
        invoiceNo: "CLI-1",
        lines: [{ name: "Bread", price: 2.5, quantity: 2, taxId: 1, taxPercent: 15 }],
        payments: [{ moneyType: "Cash", amount: 5 }],
      }),
    );
    const submit = await cli("submit", "receipt.json", "--json");
    assert.equal(submit.code, 0, submit.out);
    const submitted = JSON.parse(submit.out);
    assert.equal(submitted.receiptGlobalNo, 1);
    assert.equal(submitted.total, 5);
    assert.deepEqual(submitted.validationErrors, []);
    assert.match(submitted.qrData, /^https:\/\/fdmstest\.zimra\.co\.zw\/0000000900/);
    assert.ok(!existsSync(join(dir, "profile", "pending-submit.json")), "marker cleared");
    const persisted = JSON.parse(readFileSync(join(dir, "profile", "last-receipt-global-no.json"), "utf-8"));
    assert.equal(persisted.lastReceiptGlobalNo, 1);

    const close = await cli("day", "close");
    assert.equal(close.code, 0, close.out);
    for (let i = 0; i < 40 && sim.devices.get(900)!.status !== "FiscalDayClosed"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(sim.devices.get(900)!.status, "FiscalDayClosed");
  });

  it("refuses a price with more than two decimals before touching the network", async () => {
    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify({ currency: "USD", invoiceNo: "X", lines: [{ name: "a", price: 1.005, quantity: 1, taxId: 1, taxPercent: 15 }], payments: [{ moneyType: "Cash", amount: 1 }] }),
    );
    const before = sim.log.length;
    const res = await cli("submit", "bad.json");
    assert.equal(res.code, 1);
    assert.match(res.out, /more than two decimal places/);
    assert.equal(sim.log.length, before);
  });
});
