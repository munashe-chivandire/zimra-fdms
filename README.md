<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/munashe-chivandire/zimra-fdms/main/docs/img/logo-dark.webp">
    <img alt="zimra-fdms" src="https://raw.githubusercontent.com/munashe-chivandire/zimra-fdms/main/docs/img/logo-light.webp" width="360">
  </picture>
</p>

# zimra-fdms

TypeScript SDK for the ZIMRA Fiscalisation Data Management System (FDMS) —
talk **directly** to FDMS with your own device certificates. No middleware, no
per-receipt rent.

Everything here is verified live against ZIMRA's FDMS test environment:
device registration, mTLS, receipt signing (including the hash chain), QR
generation and signed fiscal-day close all pass ZIMRA's own validation.

The fiscal engine has no platform imports. The same code runs on Node, Bun,
Deno, in a browser, and on Android through React Native with the device key
held in Android Keystore. Node is one adapter over it, not the other way
round.

## Why this exists

Every Zimbabwean POS/invoicing/accounting product has to integrate FDMS, and
everyone re-solves the same hard parts alone: certificate lifecycle, the
stateful fiscal-day cycle, receipt counters and hash chains, canonical
signing strings, offline queueing, and FDMS's cryptic errors. This SDK does
those parts once, correctly, in the open.

## Install

```sh
npm install zimra-fdms
```

Node 18+. Three runtime dependencies: `@peculiar/x509` (certificate
parsing), `@modelcontextprotocol/server` and `zod` (the MCP server). The
core itself depends on nothing.

Three entry points:

| Import | What you get | Runs on |
| --- | --- | --- |
| `zimra-fdms` | The Node bundle: core plus `PemSigner`, `NodeTransport`, the CLI and MCP server. What 0.3.x code imports. | Node 18+ |
| `zimra-fdms/core` | `FiscalDevice`, signing strings, counters, hash chain, QR, offline queue, `buildCsr`. You supply a `Signer` and a `Transport`. | Anything with ES2020 |
| `@zimra-fdms/react-native` | `KeystoreSigner` and `OkHttpTransport` over a Kotlin module, in [packages/react-native](packages/react-native). | Android 8+ |

## CLI — fiscalise without writing code

The package ships a `zimra-fdms` command. Fastest way to a first fiscalised
receipt, and enough for ops work (checking device status, recovering a stuck
fiscal day) without touching the SDK:

```sh
npx zimra-fdms register --device-id 12345 --serial MYPOS01 --activation-key AAAABBBB
npx zimra-fdms config                       # taxpayer info + valid taxIds
npx zimra-fdms day open
npx zimra-fdms submit --sample > receipt.json   # edit to match your taxes
npx zimra-fdms submit receipt.json          # prints receipt no + QR data
npx zimra-fdms day close
```

Device identity, certificate and the fiscal-day hash chain live in a profile
directory (default `./.zimra`, override with `--profile <dir>` or
`ZIMRA_PROFILE`). Receipts chain correctly across separate invocations; if
the day-state file is ever lost, `day close` recovers by signing the counters
FDMS itself reports. That signature covers the date the day was opened, which
FDMS does not report back, so pass `--date YYYY-MM-DD` when recovering a day
opened on an earlier date. A close that FDMS rejects keeps the local state
for a retry. A day holding a receipt with a **Red** validation error (RCPT030,
RCPT012) cannot be closed by the device at all; the SDK refuses up front and
points you at ZIMRA. See [CHANGELOG.md](CHANGELOG.md) for the observed codes. `status`, `config` and `submit` take `--json` for
scripting. **Keep `.zimra/` out of version control** — it contains the
device private key.

## MCP server — fiscalise from an agent

The same binary runs an MCP server (spec revision 2026-07-28, with fallback
for 2025-era clients), so Claude Code or any MCP client can register devices,
open/close fiscal days and submit receipts:

```sh
claude mcp add zimra-fdms -- npx zimra-fdms mcp
```

Tools: `register_device`, `get_status`, `ping`, `get_config`,
`open_fiscal_day`, `close_fiscal_day`, `submit_receipt`, `sample_receipt`.
They operate on the same profile directory as the CLI (`--profile <dir>`,
`ZIMRA_PROFILE`, or `./.zimra` — and every tool also takes an optional
`profile` argument per call), so agent and terminal are interchangeable
against one device: the hash chain and day counters live on disk, not in the
session.

## Quick start

### 1. One-time device registration

Add a device on the FDMS portal (or via ZIMRA onboarding for production) to
get a **device ID**, **serial number** and **activation key**, then:

```ts
import { registerDevice } from "zimra-fdms";

const { keys, certificatePem } = await registerDevice(
  { deviceId: 12345, serialNumber: "MYPOS001", modelName: "Server", modelVersion: "v1" },
  "ACTIVKEY",
  { environment: "test" },
);
// Persist keys.privateKeyPem + certificatePem securely — they are the device identity.
```

### 2. Daily fiscal cycle

```ts
import { FiscalDevice } from "zimra-fdms";

const device = new FiscalDevice(
  { deviceId: 12345, serialNumber: "MYPOS001", modelName: "Server", modelVersion: "v1" },
  { certificatePem, privateKeyPem },
  { environment: "test" },
);

await device.getConfig();       // tax tables, qrUrl, operating mode
await device.openDay();

const sale = await device.submitReceipt({
  currency: "USD",
  invoiceNo: "INV-0001",
  lines: [
    { name: "Consulting", price: 115, quantity: 1, taxId: 513, taxPercent: 0 },
  ],
  payments: [{ moneyType: "Cash", amount: 115 }],
});
console.log(sale.qrData);       // encode this into the printed QR code

await device.closeDay();        // signed counters, computed for you
```

The SDK owns the parts everyone gets wrong: receipt counters and global
numbers, the receipt-to-receipt hash chain, fiscal-day counter accumulation,
canonical signing strings and DER-encoded ECDSA signatures.

Persist `device.getState()` after each receipt and `restoreState()` on
startup — the hash chain must survive restarts.

### 3. Amounts

Amounts are integer cents underneath. Pass a whole number of major units
(`price: 115`) or build one from a decimal string with `cents("11.50")`. A
fractional JS number throws, because 11.5 and 11.499999 are the same float
and FDMS signs over the cents:

```ts
import { cents } from "zimra-fdms";

lines: [{ name: "Bread", price: cents("2.50"), quantity: 2, taxId: 1, taxPercent: 15 }],
payments: [{ moneyType: "Cash", amount: 5 }],
```

Amounts that arrive through JSON (a POS file, an HTTP body) were exact
decimal text once; `receiptInputFromJson(input)` converts numbers with up to
two places and refuses anything finer. The CLI and MCP server do this for
you.

### 4. Surviving a crash

Give the device a `Storage` and it persists day state and a pending-submit
marker before every FDMS call. On startup, `reconcile()` loads the state and
settles a submit the process died in the middle of: it asks FDMS whether
the receipt arrived, resubmits the identical signed receipt if not, and
never issues a duplicate or skips a number.

```ts
import { FiscalDevice } from "zimra-fdms";

const device = new FiscalDevice(identity, pems, { environment: "test", stateDir: "./.zimra" });
await device.reconcile();     // on every start, before the first receipt
```

`submitReceipt()` and `closeDay()` refuse to run while a submit is
unresolved (`PendingSubmitError`), so the failure cannot compound. The CLI
profile directory is a `FileStorage`, and the CLI and MCP server reconcile
on every command.

### 5. Offline sales (72-hour grace window)

```ts
import { OfflineReceiptQueue, FileJournal } from "zimra-fdms";

const queue = new OfflineReceiptQueue(device, new FileJournal("./.zimra"));
await queue.submitOrEnqueue(receiptInput); // journals on network failure
await queue.flush();                       // FIFO retry when back online
queue.oldestPendingAgeMs;                  // warn before the 72 hours run out
```

Receipts are numbered, hash-chained and signed at sale time and appended
to a journal; `flush()` submits them in order and moves a commit cursor.
Appending is O(1), the file is never rewritten, and a crash between append
and commit leaves either a receipt to resubmit (which `reconcile()` settles)
or nothing, never a gap. Implement `Journal` (`append`, `readFrom`,
`commit`, `committed`) for SQLite or a database; a 0.3.x `QueueStorage` is
still accepted and wrapped.

### 6. Certificate renewal

```ts
const { certificatePem } = await device.renewCertificate(); // same key, new certificate
// or, to rotate the key as 0.3.x did:
const { keys, certificatePem: fresh } = await device.renewWithNewKey();
```

### 7. Keys that cannot be exported

The core never touches key material. It asks a `Signer` for signatures and
a `Transport` for HTTP, and each platform provides its own:

```ts
interface Signer {
  sign(data: Uint8Array): Promise<Uint8Array>;   // DER ECDSA P-256 over SHA-256
  publicKeySpki(): Promise<Uint8Array>;          // for the CSR
}
interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>; // owns mTLS
}
```

`buildCsr(signer, commonName)` writes the PKCS#10 request and has the
`Signer` sign it, so a key in Android Keystore, an HSM or a cloud KMS can
register without ever being exported. On Node the defaults are
`PemSigner(privateKeyPem)` and `NodeTransport({ certificatePem, privateKeyPem })`,
which is what the PEM constructor above builds for you.

```ts
import { FiscalDevice } from "zimra-fdms/core";

const device = new FiscalDevice(identity, { signer: myHsmSigner, transport: myTransport });
```

Receipt dates come from a `ServerCorrectedClock` that learns the offset to
FDMS from every response, so a terminal with a drifted clock still gets
Green receipts. `device.clock.offsetMs` tells you how far off the device is.

### 8. Android

```ts
import { KeystoreSigner, registerDevice, createFiscalDevice } from "@zimra-fdms/react-native";

const signer = await KeystoreSigner.ensure("zimra-device-12345");   // StrongBox when available
const { certificatePem } = await registerDevice(identity, "ACTIVKEY", signer, { environment: "test" });
const device = createFiscalDevice(identity, { alias: "zimra-device-12345", certificatePem });
```

See [packages/react-native/README.md](packages/react-native/README.md).

## When FDMS says no

Every `FdmsApiError` carries `explain()` (colour, cause, fix, whether the
day is still closable) and a `supportCode` like `RCPT030-0HNOABB4T00A3`
that a cashier can read out. The catalogue in
[src/core/errors.ts](src/core/errors.ts) marks which entries were observed
live and which come from the documentation.

## Hard-won implementation notes

- **Signatures are ASN.1 DER.** FDMS rejects raw IEEE P1363 (r||s) ECDSA
  signatures with `RCPT020` / `BadCertificateSignature`. WebCrypto emits
  P1363; this SDK converts to DER by default.
- **CSR subject CN** must be `ZIMRA-{serial}-{deviceId padded to 10 digits}`,
  ECDSA P-256 preferred.
- **Receipt canonical string**: `deviceID + RECEIPTTYPE + CURRENCY +
  receiptGlobalNo + receiptDate(YYYY-MM-DDTHH:mm:ss, local, no TZ) +
  total-in-cents + taxes(sorted by taxID: percent "15.00"/"" if exempt +
  taxAmount-cents + salesAmountWithTax-cents) + previousReceiptHash(base64)`,
  where the first receipt of each fiscal day omits the previous hash.
- **Fiscal-day counters** are sorted by counter-type priority, then currency,
  then taxID — and `BalanceByMoneyType` sorts by the money-type **enum
  order** (Cash, Card, …), not alphabetically. Zero-value counters are
  excluded from both the payload and the signing string.
- The test portal (`fdmsops.zimra.co.zw/fdms-public/`) can force-close a
  stuck fiscal day and reset device activation — invaluable during
  development.

## Simulator

A local FDMS with real mutual TLS, for developing and testing without a
registered device:

```sh
npx zimra-fdms-simulator --port 8443        # writes zimra-simulator-ca.pem
ZIMRA_BASE_URL=https://localhost:8443 ZIMRA_CA=zimra-simulator-ca.pem \
  npx zimra-fdms register --device-id 1 --serial DEV1 --activation-key ABCD1234
```

Or in a test suite:

```ts
import { FdmsSimulator } from "zimra-fdms/simulator";

const sim = await FdmsSimulator.create();
const { url, caPem } = await sim.start();
const device = new FiscalDevice(identity, pems, { baseUrl: url, ca: caPem });
sim.faults.dropAfterSubmit = 1;   // FDMS takes the receipt, the answer is lost
```

It issues certificates from the same CSR the SDK sends ZIMRA, verifies every
receipt and CloseDay signature with the same canonical-string rules, and
replays the validation behaviour observed live: RCPT010, RCPT011, RCPT012,
RCPT013, RCPT014, RCPT020, RCPT021, RCPT030, RCPT031, the asynchronous close
that settles to `FiscalDayClosed` or bounces with `BadCertificateSignature`
or `ReceiptsWithValidationErrors`, and GetStatus reporting the receipt with
the latest date rather than the highest number. Faults: dropped connections,
5xx, delays, a skewed `Date` header, and a lost SubmitReceipt answer.

It is not ZIMRA. Passing against it means the SDK is consistent with itself;
the nightly run against the real test environment is still the authority.

## Conformance vectors

[vectors/zimra-fdms-vectors.json](vectors/zimra-fdms-vectors.json) holds
canonical strings, SHA-256 hashes, DER signatures, tax summaries and QR
payloads for a fixed P-256 test key, across currencies, tax mixes, a credit
note and a large amount. A port in any language proves itself with the
runner, which pipes each vector to a command as JSON and checks the answer:

```sh
npx zimra-fdms-conformance -- python3 my_port_responder.py
```

The protocol is in [src/conformance/cli.ts](src/conformance/cli.ts) and
[reference.ts](src/conformance/reference.ts) is a responder built on this
SDK to copy from. Signatures are verified against the public key rather
than compared, since ECDSA is randomised.

## Testing

```sh
npm test          # 120+ tests: signing rules, core primitives, crash safety, simulator, vectors, CLI, MCP
npm run lint:core # fails if src/core references node:*, Buffer, process or fetch
npm run test:e2e  # full live cycle against the FDMS test environment
ZIMRA_BASE_URL=https://localhost:8443 ZIMRA_CA=zimra-simulator-ca.pem npm run test:e2e   # same cycle, simulator
```

The regression tests pin the canonical signing strings, DER conversion, tax
computation, counter accumulation and QR format — the exact things a ZIMRA
spec revision would silently break. The core tests check the pure SHA-256,
MD5 and base64 against `node:crypto`, the CSR builder against
`@peculiar/x509`, and run a whole fiscal day through `dist/core` inside a VM
context that has no `Buffer`, `process`, `require` or `fetch`.

## Project layout

`src/core/` has no platform imports and is what every runtime shares:

- `device.ts` — `FiscalDevice`: config, status, open/close day, receipts
- `signing.ts` — canonical strings and tax maths
- `signer.ts` — the `Signer` interface, DER and P1363 conversion
- `csr.ts`, `asn1.ts` — PKCS#10 request built with a small DER writer
- `transport.ts` — the `Transport` interface and `FdmsClient` (headers, paths, errors)
- `clock.ts` — `ServerCorrectedClock`
- `sha256.ts`, `md5.ts`, `bytes.ts` — hashing and byte helpers in plain TypeScript
- `qr.ts` — verification QR data
- `queue.ts`, `journal.ts` — offline receipt queue over an append-only journal
- `money.ts` — integer cents, `cents("11.50")`
- `storage.ts` — the `Storage` interface behind crash-safe state
- `errors.ts` — the error catalogue: colour, cause and fix per code, `explain()`
- `registration.ts` — RegisterDevice / GetServerCertificate over any `Transport`

`src/node/` is the Node adapter:

- `pem-signer.ts` — `PemSigner` over WebCrypto, key imported once
- `transport.ts` — `NodeTransport`: mTLS over node:https with a keep-alive agent
- `keys.ts` — exportable key pair generation for backups
- `storage.ts` — `FileStorage` (atomic JSON files) and `FileJournal` (JSONL)
- `cli.ts`, `mcp.ts`, `profile.ts` — the CLI, the MCP server and their shared profile directory

`src/simulator/` is the local FDMS, `src/conformance/` the vector runner and
reference responder, `vectors/` the published vectors. `packages/react-native/`
is the Android adapter. `spec/` holds ZIMRA's OpenAPI specs, fetched from the
official test Swagger.

## Test environment

- API: `https://fdmsapitest.zimra.co.zw` (Swagger at `/swagger/index.html`)
- Self-service device portal: `https://fdmsops.zimra.co.zw/fdms-public/add-device`
- Invoice validation: `https://fdmstest.zimra.co.zw`

## Need managed compliance?

This SDK solves the integration. If you want someone to handle ZIMRA
onboarding, approval, ITF263 and ongoing compliance monitoring, talk to
**Goko Consultancy and Training Services**.

## License

MIT
