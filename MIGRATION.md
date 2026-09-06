# Migrating from 0.3.x to 0.4.0

Most 0.3.x code compiles and runs unchanged. The items below are the ones
that can bite, in the order you are likely to meet them.

## Fractional amounts throw

```ts
// 0.3.x
lines: [{ name: "Bread", price: 2.5, quantity: 2, taxId: 1, taxPercent: 15 }]

// 0.4.0
import { cents } from "zimra-fdms";
lines: [{ name: "Bread", price: cents("2.50"), quantity: 2, taxId: 1, taxPercent: 15 }]
```

Whole numbers (`price: 115`) still mean major units and still work. A
fractional JS number now throws with the field name, because FDMS signs over
cents and 2.5 cannot be told from 2.4999999 once it is a float. If your
amounts arrive as JSON, call `receiptInputFromJson(input)` at the edge; it
converts numbers with up to two decimal places and refuses finer ones. The
CLI and MCP server already do.

## Signing takes a Signer, not a PEM

```ts
// 0.3.x
signCanonicalString(privateKeyPem, canonical, "der")

// 0.4.0
import { PemSigner } from "zimra-fdms";
signCanonicalString(new PemSigner(privateKeyPem), canonical, "der")
```

`new FiscalDevice(device, { certificatePem, privateKeyPem }, opts)` is
unchanged; it builds the `PemSigner` and `NodeTransport` for you. The core
form is `new FiscalDevice(device, { signer, transport, storage? }, opts)`.

## p1363ToDer returns Uint8Array

It took and returned a `Buffer`. A `Buffer` is a `Uint8Array`, so callers
passing one are unaffected. A caller doing `.toString("base64")` on the
result should use `toBase64()` from the core, or wrap in `Buffer.from()`.

## renewCertificate() reuses the key

```ts
// 0.3.x: a fresh key pair every renewal
const { keys, certificatePem } = await device.renewCertificate();

// 0.4.0: same key, new certificate
const { certificatePem } = await device.renewCertificate();
// or, the old behaviour by name:
const { keys, certificatePem: fresh } = await device.renewWithNewKey();
```

## registerDevice() with an existing key

`registerDevice(device, activationKey, options)` still generates an
exportable key and returns `keys`. To register a key that already exists
(a keystore, an HSM), pass a `Signer` as the third argument:
`registerDevice(device, activationKey, signer, options)`.

## Offline queue: Journal instead of QueueStorage

```ts
// 0.3.x
new OfflineReceiptQueue(device, myQueueStorage)

// 0.4.0
import { FileJournal } from "zimra-fdms";
new OfflineReceiptQueue(device, new FileJournal("./.zimra"))
```

A `QueueStorage` is still accepted and wrapped. Receipts are now signed at
sale time, so `enqueue()` advances the device counters immediately and
returns the signed `PreparedReceipt`. Unsigned receipts left in an old
snapshot are signed, in order, the first time the queue loads. `flush()`
semantics are unchanged.

## Deep imports moved

`src/signing.ts`, `src/device.ts` and friends now live under `src/core/`;
`src/http.ts` became `src/node/transport.ts` (`NodeTransport`) and
`src/crypto.ts` became `src/node/keys.ts`. `FdmsHttpClient` is now
`FdmsClient` over a `Transport`:

```ts
// 0.3.x
new FdmsHttpClient(device, { certificatePem, privateKeyPem }, { environment })

// 0.4.0
new FdmsClient(device, new NodeTransport({ certificatePem, privateKeyPem }), { environment })
```

Everything public is exported from `zimra-fdms`; prefer that over deep paths.

## Things you get without changing code

- Give the device a `stateDir` (Node) or a `Storage` (core) and call
  `reconcile()` on startup; a crash mid-submit can no longer duplicate or
  skip a receipt number. The CLI profile directory already is one.
- Receipt dates come from a server-corrected clock, so a device with a wrong
  clock still produces Green receipts.
- `FdmsApiError.explain()` and `.supportCode`.
- Idempotent calls (GET endpoints, Ping) retry twice with jitter on network
  failure. SubmitReceipt is never retried; a lost answer goes through
  `reconcile()`.
- `ZIMRA_BASE_URL` and `ZIMRA_CA` point the CLI, MCP server and e2e script at
  `npx zimra-fdms-simulator`.
