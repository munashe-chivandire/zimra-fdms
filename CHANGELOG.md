# Changelog

All changes verified live against ZIMRA's FDMS test environment on device 37367
unless noted.

## 0.4.0 — unreleased

The core now runs anywhere. This is the first step of the 1.0 plan: no
fiscal behaviour changes, and 0.3.x code keeps working.

### Added

- **`zimra-fdms/core`**: the fiscal engine with no platform imports. No
  `node:*`, no `Buffer`, no `fetch`, no `structuredClone`. SHA-256, MD5 and
  base64 are implemented in plain TypeScript, so hashing stays synchronous
  and works on Hermes, Deno, Bun and browsers without polyfills. A lint step
  (`npm run lint:core`) fails the build if a platform reference creeps in,
  and a test drives a full fiscal day through `dist/core` inside a VM
  context that has none of those globals.
- **`Signer`** interface. `FiscalDevice` takes a `Signer` and never sees key
  material, so the key can live in a PEM, Android Keystore, an HSM or a
  cloud KMS. `PemSigner` in the Node package wraps the 0.3.x PEM and imports
  the key once instead of once per receipt.
- **CSR built in the core.** `buildCsr(signer, commonName)` writes the
  PKCS#10 request with a small DER encoder and has the `Signer` sign it, so a
  key that cannot be exported can still register. Output is byte-identical
  to the @peculiar/x509 request 0.3.x sent, minus the randomised signature.
- **`Transport`** interface. `NodeTransport` uses one keep-alive `https.Agent`
  per device so the TLS handshake and PEM parse happen once per process.
  `FetchTransport` covers the Public endpoints on any runtime with `fetch`.
- **`ServerCorrectedClock`.** `FiscalDevice` learns the offset to FDMS from
  every response `Date` header and stamps receipts and day-open times with
  server time. `device.clock.offsetMs` and `.confidence` are readable.
- **`renewCertificate()`** in the core reuses the device's key. The Node
  `FiscalDevice` keeps the 0.3.x rotate-the-key behaviour under
  `renewWithNewKey()`.
- **`@zimra-fdms/react-native`** in `packages/react-native`: `KeystoreSigner`
  and `OkHttpTransport` over a Kotlin module. Written, typechecked, not yet
  run on a device.

### Changed

- Sources moved to `src/core` and `src/node`. `import ... from "zimra-fdms"`
  still resolves to the Node bundle; deep imports of `src/*.ts` paths change.
- `p1363ToDer` takes and returns `Uint8Array`. A `Buffer` is a `Uint8Array`,
  so callers passing one are unaffected; callers doing
  `.toString("base64")` on the result should use `toBase64()` from the core.
- `signCanonicalString(signer, canonical, format)` takes a `Signer` instead
  of a PEM string. Wrap the PEM: `new PemSigner(privateKeyPem)`.
- `registerDevice(device, key, signer, options)` is the core signature. The
  Node export keeps `registerDevice(device, key, options)` generating an
  exportable PEM as before.
- `package-lock.json` regenerated against registry.npmjs.org; 0.3.1's
  lockfile resolved every package to a mirror.
- TypeScript target is ES2020 so the compiled core runs on Hermes.

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
