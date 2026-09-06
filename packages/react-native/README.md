# @zimra-fdms/react-native

Android adapter for [zimra-fdms](../../README.md). The device key is created
inside Android Keystore (StrongBox where the phone has one) with
`PURPOSE_SIGN` only, so it cannot be exported, copied to another phone or
read by a rooted process. The same key signs receipts and authenticates the
mutual-TLS connection to FDMS.

Everything fiscal runs in `zimra-fdms/core` on Hermes: canonical strings,
SHA-256, MD5 for the QR checksum, counters and the hash chain. The native
module does three things: generate and hold the key, sign bytes, and run
HTTPS with the key as the client identity.

## Install

```sh
npm install zimra-fdms @zimra-fdms/react-native
```

Autolinking picks up the Android module. Expo managed projects need a
development build; the module does not run in Expo Go. Android 8 (API 26)
or later.

## Register once

```ts
import { KeystoreSigner, registerDevice } from "@zimra-fdms/react-native";

const signer = await KeystoreSigner.ensure("zimra-device-12345");
const { certificatePem } = await registerDevice(
  { deviceId: 12345, serialNumber: "MYPOS001", modelName: "Android", modelVersion: "1" },
  "ACTIVKEY",
  signer,
  { environment: "test" },
);
// Persist certificatePem (it is public). The key stays in the keystore.
```

## Every day

```ts
import { createFiscalDevice } from "@zimra-fdms/react-native";

const device = createFiscalDevice(
  { deviceId: 12345, serialNumber: "MYPOS001", modelName: "Android", modelVersion: "1" },
  { alias: "zimra-device-12345", certificatePem },
  { environment: "test" },
);

await device.openDay();
const sale = await device.submitReceipt({ /* same ReceiptInput as Node */ });
await device.closeDay();
```

Persist `device.getState()` after each receipt and `restoreState()` on
launch, exactly as on Node. Receipt dates come from a clock corrected by
FDMS response headers, so a phone with a wrong clock still produces Green
receipts.

## Key attestation

`signer.attestationChain()` returns the attestation certificate chain as PEM.
A bank or auditor can verify from it that the key is hardware-backed and
which security level (TEE or StrongBox) holds it.

## Status

The Kotlin module and the TypeScript bindings are written against the
public Android and React Native APIs and typecheck, but have not yet run on
a device or emulator. Treat the first on-device run as part of adopting
this package.
