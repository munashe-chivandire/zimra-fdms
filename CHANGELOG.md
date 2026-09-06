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
  and `OkHttpTransport` over a Kotlin module. The keystore and mutual-TLS
  logic ran on an Android 16 emulator through `android/check`, a plain-Java
  twin built with the SDK tools, driven by `scripts/android-check.sh`: key
  in Android Keystore, CSR signed by it, RegisterDevice, mTLS, receipts,
  reconcile, CloseDay. That run showed a keystore key needs `DIGEST_NONE`
  for TLS client auth; the Kotlin module sets it. The Kotlin has not yet
  been built with Gradle.
- **Integer cents.** `ReceiptInput` amounts are a whole number of major
  units or `cents("11.50")`; a fractional JS number throws, naming the
  field. Tax, totals, payments and counters are computed in integer cents
  and rounded per line. `receiptInputFromJson()` converts amounts that came
  through JSON with up to two places; the CLI and MCP server apply it.
- **Crash safety.** With a `Storage`, `FiscalDevice` writes a
  pending-submit marker before every SubmitReceipt and `reconcile()` settles
  it on the next start: confirms with GetStatus, resubmits the identical
  signed receipt, or reports a rejection. `submitReceipt()`, `openDay()`
  and `closeDay()` throw `PendingSubmitError` while a marker exists. The
  highest global number ever issued is kept in storage and `openDay()`
  takes the largest of server, stored and given values. `FileStorage` on
  Node writes atomically and uses the CLI profile file names, so the CLI
  and MCP server get this for free (`stateDir`, and they reconcile on every
  command).
- **Append-only journal.** `OfflineReceiptQueue` signs at sale time
  (`signReceipt()` + `applyPrepared()`), appends to a `Journal`, and
  commits a cursor per delivered receipt. `FileJournal` (JSONL) on Node,
  `MemoryJournal` in core, `journalFromQueueStorage()` wraps a 0.3.x
  `QueueStorage` and upgrades its unsigned entries on load.
  `oldestPendingAgeMs` for the 72-hour window. A flush that died after
  writing the marker is settled through `reconcile()`, not sent twice.
- **`zimra-fdms/simulator`** and `npx zimra-fdms-simulator`: a local FDMS
  with a generated CA and real mutual TLS. Issues certificates from the
  SDK's CSR, verifies every signature with the shared canonical-string
  code, replays RCPT010/011/012/013/014/020/021/030/031, the asynchronous
  close with `BadCertificateSignature` and `ReceiptsWithValidationErrors`,
  and the GetStatus under-report. Faults: dropped connections, 5xx, delay,
  skewed `Date`, lost SubmitReceipt answer. `baseUrl` on the client options
  and `ZIMRA_BASE_URL` / `ZIMRA_CA` on the CLI, MCP server and e2e script
  point at it.
- **Conformance vectors** in `vectors/zimra-fdms-vectors.json` (also
  `zimra-fdms/vectors`) for a fixed test key, and `npx zimra-fdms-conformance
  -- <command>` to check any implementation against them over a stdin/stdout
  JSON protocol. `src/conformance/reference.ts` is the responder to port.
- **Error catalogue.** `ERROR_CATALOGUE`, `explainCode()`,
  `FdmsApiError.explain()` and `.supportCode`, `explainValidationError()`.
  Colour, cause, fix and whether the day is still closable per code, with
  observed entries marked. Fixes the old RCPT012 hint, which described a
  duplicate invoice number; the live meaning is a non-sequential global
  number.
- Idempotent calls (GET endpoints and Ping) retry twice with jittered
  backoff on a network failure (`retries` in the client options).
  SubmitReceipt, OpenDay and CloseDay are never retried by the client.
- `MIGRATION.md` walks through every 0.3.x change.
- CI runs on Node 18, 20, 22 and 24, lints the core for platform imports,
  runs the conformance runner against the reference, and typechecks the
  Android bindings against real React Native types.

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
- `closeDay()` no longer clears stored day state on an accepted close; the
  close is asynchronous and a rejected one needs the counters for a retry.
  `clearPersistedState()` deletes it once GetStatus reports
  `FiscalDayClosed`.
- `README` dependency count corrected: three runtime dependencies, none in
  the core.

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
