/**
 * Day-close recovery helpers. Offline: the FDMS calls live in
 * closeFromServerCounters and are covered by scripts/e2e.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveFiscalDayDate, ProfileError } from "../src/profile.js";

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
