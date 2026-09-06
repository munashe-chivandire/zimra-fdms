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

### 3. Offline sales (72-hour grace window)

```ts
import { OfflineReceiptQueue } from "zimra-fdms";

const queue = new OfflineReceiptQueue(device /*, custom QueueStorage */);
await queue.submitOrEnqueue(receiptInput); // queues on network failure
await queue.flush();                       // FIFO retry when back online
```

**Custom storage**

The queue keeps pending receipts in memory by default. To persist them across
restarts — or to keep a separate queue per tenant — implement `QueueStorage`
and pass it as the second constructor argument:

```ts
import { OfflineReceiptQueue } from "zimra-fdms";
import type { QueueStorage, ReceiptInput } from "zimra-fdms";

export class CustomQueueStorage implements QueueStorage {
  constructor(private readonly tenantId: string) {}

  async load(): Promise<ReceiptInput[]> {
    // Oldest first. Order by a persisted sequence column — not by whatever
    // order the database happens to return rows in.
    return loadItemsFromDB(this.tenantId);
  }

  async save(pending: ReceiptInput[]): Promise<void> {
    // Replace the whole snapshot; an empty array means "clear the queue".
    await replaceItemsInDB(this.tenantId, pending);
  }
}

const queue = new OfflineReceiptQueue(
  device,
  new CustomQueueStorage("<tenant id>"),
);
```

Both rules matter after a crash. `flush()` calls `save()` with the remaining
receipts after each successful submission, so an append-only implementation
re-sends receipts that ZIMRA already accepted. And receipts are numbered and
hash-chained at flush time, not at sale time — so whatever order `load()`
returns is the order they are fiscalized in.

### 4. Certificate renewal

```ts
const { certificatePem } = await device.renewCertificate(); // same key, new certificate
// or, to rotate the key as 0.3.x did:
const { keys, certificatePem: fresh } = await device.renewWithNewKey();
```

### 5. Keys that cannot be exported

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

### 6. Android

```ts
import { KeystoreSigner, registerDevice, createFiscalDevice } from "@zimra-fdms/react-native";

const signer = await KeystoreSigner.ensure("zimra-device-12345");   // StrongBox when available
const { certificatePem } = await registerDevice(identity, "ACTIVKEY", signer, { environment: "test" });
const device = createFiscalDevice(identity, { alias: "zimra-device-12345", certificatePem });
```

See [packages/react-native/README.md](packages/react-native/README.md).

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

## Testing

```sh
npm test          # signing rules, core primitives, CLI and MCP (no network)
npm run lint:core # fails if src/core references node:*, Buffer, process or fetch
npm run test:e2e  # full live cycle against the FDMS test environment
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
- `queue.ts` — offline receipt queue
- `registration.ts` — RegisterDevice / GetServerCertificate over any `Transport`

`src/node/` is the Node adapter:

- `pem-signer.ts` — `PemSigner` over WebCrypto, key imported once
- `transport.ts` — `NodeTransport`: mTLS over node:https with a keep-alive agent
- `keys.ts` — exportable key pair generation for backups
- `cli.ts`, `mcp.ts`, `profile.ts` — the CLI, the MCP server and their shared profile directory

`packages/react-native/` is the Android adapter. `spec/` holds ZIMRA's
OpenAPI specs, fetched from the official test Swagger.

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
