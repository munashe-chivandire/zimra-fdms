# Changelog

All changes verified live against ZIMRA's FDMS test environment on device 37367
unless noted.

## 0.3.1 — 2026-08-23

Recovery fixes. Everything here came out of one stuck fiscal day.

### Fixed

- **Day-close recovery signed with today's date.** CloseDay is signed over the
  date the day was *opened*. FDMS never reports that date, and the recovery
  path (no local `day-state.json`) assumed today, so a day opened on an
  earlier date failed with `BadCertificateSignature`. `zimra-fdms day close`
  takes `--date YYYY-MM-DD`; the MCP `close_fiscal_day` tool takes
  `fiscalDayDate`; both say when they are assuming today.
- **Local day state deleted before the close was confirmed.** CloseDay is
  asynchronous. The CLI and MCP tool removed `day-state.json` as soon as the
  request was accepted, so a close that FDMS later rejected lost the real
  counters and date. State is now cleared only once FDMS reports
  `FiscalDayClosed`.
- **Receipt numbering after a future-dated receipt.** `GetStatus.lastReceiptGlobalNo`
  is the number of the receipt with the latest `receiptDate`, not the highest
  number issued. After a future-dated receipt (Yellow RCPT031) it under-reports,
  and the next day's first receipt got a Red RCPT012. The profile now keeps the
  highest number it has issued in `last-receipt-global-no.json` and `openDay`
  uses the larger of that and the server's value. Library users can pass
  `openDay(undefined, new Date(), { lastReceiptGlobalNo })`.
- `ValidationError.validationErrorText` renamed to `validationErrorDescription`
  to match what FDMS actually sends.
- `zimra-fdms submit` and the MCP `submit_receipt` tool accept `receiptDate`
  (ISO 8601) for backfilling.

### Added

- **Red validation errors are tracked and block the close.** A day holding a
  receipt with a Red validation error (RCPT012, RCPT030, …) cannot be closed
  by the device; FDMS rejects it with `ReceiptsWithValidationErrors` and only
  ZIMRA can close it. `submitReceipt` records Red errors in the day state,
  `submit` warns immediately, and `day close` / `close_fiscal_day` refuse up
  front with the portal link instead of failing 30 seconds later. `--force` /
  `force: true` submits anyway. Library: `DayNotClosableError`,
  `FiscalDayState.redErrors`.
- `scripts/provoke-rcpt030.ts` reproduces the RCPT031 → RCPT030 sequence.

### Observed FDMS behaviour (test environment, 2026-08-23)

| Code | Colour | Day still closable by device |
|---|---|---|
| RCPT031 future receipt date | Yellow | yes |
| RCPT014 receipt date before day opened | Yellow | yes |
| RCPT030 receipt date earlier than previous receipt | **Red** | **no** |
| RCPT012 global number not sequential | **Red** | **no** |

After a future-dated receipt, every later receipt must carry a date strictly
after it (the SDK nudges auto-generated dates by one second) until real time
catches up. Submitting a receipt with the real time before then is RCPT030
and bricks the day.

## 0.3.0 — 2026-08-18

- MCP server: `zimra-fdms mcp` exposes eight tools over the CLI profile
  (MCP spec 2026-07-28, `@modelcontextprotocol/server` v2).
- Profile and day-state logic moved to `src/profile.ts`, shared by CLI and MCP.
- Monotonic `receiptDate` guard: FDMS rejects same-second receipts (RCPT030);
  `previousReceiptDate` is persisted in day state.
- Docs: custom `QueueStorage` implementation (#2).

## 0.2.0 — 2026-07-31

- CLI: `register`, `status`, `ping`, `config`, `day open|close`, `submit`.
  Profile directory `./.zimra` persists the hash chain between processes.
- `day close` recovers from server counters when local state is lost.
- Spec-drift watcher (`npm run spec:drift`).
- `sharp` removed from dependencies.

## 0.1.0 — 2026-07-29

- First release: device registration, mTLS, DER ECDSA receipt signing, fiscal
  days, hash-chained receipts, offline queue, QR data. Full E2E passed against
  the FDMS test environment; QR validated on fdmstest.zimra.co.zw.
