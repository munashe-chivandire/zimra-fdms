/**
 * Day-close recovery helpers. Offline: the FDMS calls live in
 * closeFromServerCounters and are covered by scripts/e2e.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveFiscalDayDate, ProfileError } from "../src/node/profile.js";

describe("resolveFiscalDayDate", () => {
  it("uses the explicit date and does not flag it as assumed", () => {
    assert.deepEqual(resolveFiscalDayDate("2026-08-18"), {
      fiscalDayDate: "2026-08-18",
      assumedToday: false,
    });
  });

  it("falls back to today's local date and says so", () => {
    const r = resolveFiscalDayDate();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    assert.equal(
      r.fiscalDayDate,
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    );
    assert.equal(r.assumedToday, true);
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    for (const bad of ["18/08/2026", "2026-8-18", "2026-13-45", "yesterday", ""]) {
      assert.throws(() => resolveFiscalDayDate(bad), ProfileError, bad);
    }
  });
});

import { FiscalDevice } from "../src/node/device.js";
import { DayNotClosableError } from "../src/core/device.js";

const DUMMY_DEVICE = new FiscalDevice(
  { deviceId: 1, serialNumber: "X", modelName: "Server", modelVersion: "v1" },
  { certificatePem: "", privateKeyPem: "" },
  { environment: "test" },
);

describe("closeDay with Red validation errors", () => {
  const state = {
    fiscalDayNo: 15,
    fiscalDayDate: "2026-08-23",
    receiptCounter: 2,
    receiptGlobalNo: 23,
    counters: [],
    redErrors: [{ receiptGlobalNo: 23, receiptCounter: 2, code: "RCPT030" }],
  };

  it("refuses before touching the network and names the receipt", async () => {
    DUMMY_DEVICE.restoreState(state);
    await assert.rejects(
      () => DUMMY_DEVICE.closeDay(),
      (err: unknown) =>
        err instanceof DayNotClosableError &&
        err.fiscalDayNo === 15 &&
        /global no 23: RCPT030/.test(err.message),
    );
  });

  it("proceeds with force (fails later on the empty key, not on the guard)", async () => {
    DUMMY_DEVICE.restoreState(state);
    await assert.rejects(
      () => DUMMY_DEVICE.closeDay({ force: true }),
      (err: unknown) => !(err instanceof DayNotClosableError),
    );
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLastGlobalNo, saveLastGlobalNo, saveDayState, type Profile } from "../src/node/profile.js";

describe("last receipt global number", () => {
  const dir = mkdtempSync(join(tmpdir(), "zimra-profile-test-"));
  const p = {
    dir,
    device: { deviceId: 7, serialNumber: "S", modelName: "Server", modelVersion: "v1", environment: "test" },
    certificatePem: "",
    privateKeyPem: "",
  } as unknown as Profile;

  it("is undefined until a receipt has been issued", () => {
    assert.equal(loadLastGlobalNo(p), undefined);
  });

  it("only ever moves up", () => {
    saveLastGlobalNo(p, 24);
    saveLastGlobalNo(p, 22);
    assert.equal(loadLastGlobalNo(p), 24);
  });

  it("is written by saveDayState", () => {
    saveDayState(p, {
      fiscalDayNo: 1,
      fiscalDayDate: "2026-08-23",
      receiptCounter: 3,
      receiptGlobalNo: 30,
      counters: [],
    });
    assert.equal(loadLastGlobalNo(p), 30);
    rmSync(dir, { recursive: true, force: true });
  });
});
