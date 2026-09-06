# zimra-fdms-react-native

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
npm install zimra-fdms zimra-fdms-react-native
```

Autolinking picks up the Android module. Expo managed projects need a
development build; the module does not run in Expo Go. Android 8 (API 26)
or later.

## Register once

```ts
import { KeystoreSigner, registerDevice } from "zimra-fdms-react-native";

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
import { createFiscalDevice } from "zimra-fdms-react-native";

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

The keystore and mutual-TLS logic has run on an Android 16 emulator:
`android/check` is the same code in plain Java, built with the SDK tools
alone, and `scripts/android-check.sh` drives the real TypeScript core
through it against the simulator. Key generation in Android Keystore, a CSR
built by the core and signed by the keystore, RegisterDevice, mutual TLS
with the keystore key as client identity, two receipts, a lost answer
settled by `reconcile()`, and a signed CloseDay all pass.

That run found one thing the docs do not tell you: a keystore key used for
TLS client authentication needs `DIGEST_NONE` in its digests as well as
`SHA256`, because Conscrypt signs the already-hashed transcript. Both the
check app and the Kotlin module set it.

What has not happened yet is a Gradle build of the React Native module
itself, which needs a network the machine that wrote this did not have.
The Kotlin mirrors the Java line for line, but its first build in your app
is still the first build.

## Emulator check

```sh
# an emulator or device on adb, a JDK, the Android SDK
bash scripts/android-check.sh
```
