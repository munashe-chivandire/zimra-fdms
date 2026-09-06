/**
 * Drive the real core with an Android emulator as the Signer and Transport.
 *
 * The emulator runs packages/react-native/android/check (built by
 * scripts/android-check.sh), which exposes the keystore and an mTLS HTTP
 * client on a port forwarded by adb. This script starts the simulator with
 * a certificate for 10.0.2.2, registers a device whose key was generated
 * inside Android Keystore, and runs a fiscal day with every signature and
 * the TLS handshake done on the device.
 *
 *   ADB_FORWARD_PORT=9999 npx tsx scripts/android-emulator-e2e.ts
 */
import { FdmsSimulator } from "../src/simulator/server.js";
import { FiscalDevice, registerDevice, buildCsr, deviceCommonName, MemoryStorage } from "../src/core/index.js";
import type { Signer, Transport, TransportRequest, TransportResponse } from "../src/core/index.js";
import { fromBase64, toBase64, pemToDer } from "../src/core/bytes.js";
import { cents } from "../src/core/money.js";
import { TransportError } from "../src/core/transport.js";
import * as x509 from "@peculiar/x509";

const BRIDGE = `http://127.0.0.1:${process.env.ADB_FORWARD_PORT ?? "9999"}`;
const ALIAS = "zimra-check-" + Date.now();
const SIM_PORT = Number(process.env.SIM_PORT ?? "8443");

async function bridge<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(BRIDGE + path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (json.error) throw new Error(`${path}: ${json.error}: ${json.message}`);
  return json;
}

/** Signer over the emulator's keystore. */
const signer: Signer = {
  sign: async (data) => fromBase64((await bridge<{ signatureBase64: string }>("/sign", { alias: ALIAS, dataBase64: toBase64(data) })).signatureBase64),
  publicKeySpki: async () => fromBase64((await bridge<{ spkiBase64: string }>("/spki", { alias: ALIAS })).spkiBase64),
};

/** Transport over the emulator's HttpsURLConnection, with the keystore key as the TLS identity. */
function deviceTransport(caPem: string, certificatePem?: string): Transport {
  return {
    async request(req: TransportRequest): Promise<TransportResponse> {
      // The emulator reaches the host at 10.0.2.2.
      const url = req.url.replace("https://localhost:", "https://10.0.2.2:");
      try {
        return await bridge<TransportResponse>("/request", {
          alias: certificatePem ? ALIAS : null,
          certificatePem: certificatePem ?? null,
          caPem,
          method: req.method,
          url,
          headers: req.headers,
          body: req.body ?? null,
          timeoutMs: req.timeoutMs,
        });
      } catch (e) {
        throw new TransportError(e instanceof Error ? e.message : String(e), e);
      }
    },
  };
}

const ok = (label: string, detail = "") => console.log(`  ok   ${label}${detail ? "  " + detail : ""}`);

const ping = await bridge<{ ok: boolean; sdk: number }>("/ping");
ok("bridge reachable", `Android SDK ${ping.sdk}`);

const sim = await FdmsSimulator.create({ port: SIM_PORT, host: "0.0.0.0", hosts: ["10.0.2.2"], closeDelayMs: 100 });
const { url, caPem } = await sim.start();
ok("simulator listening", url);

try {
  const key = await bridge<{ strongBox: boolean }>("/key", { alias: ALIAS });
  ok("key generated in Android Keystore", key.strongBox ? "StrongBox" : "TEE (emulator has no StrongBox)");

  const identity = { deviceId: 7001, serialNumber: "EMU001", modelName: "AndroidCheck", modelVersion: "1" };
  const csrPem = await buildCsr(signer, deviceCommonName(identity.serialNumber, identity.deviceId));
  const csr = new x509.Pkcs10CertificateRequest(pemToDer(csrPem));
  if (!(await csr.verify())) throw new Error("CSR signed by the keystore does not verify");
  ok("CSR built by the core, signed by the keystore, verifies", csr.subject);

  const reg = await registerDevice(identity, "EMUKEY01", signer, { baseUrl: url, transport: deviceTransport(caPem) });
  ok("RegisterDevice through the device's HTTP stack", reg.commonName);

  const cert = new x509.X509Certificate(reg.certificatePem);
  const spki = await signer.publicKeySpki();
  if (Buffer.from(cert.publicKey.rawData).toString("hex") !== Buffer.from(spki).toString("hex")) {
    throw new Error("issued certificate does not carry the keystore public key");
  }
  ok("issued certificate carries the keystore public key");

  const attestation = await bridge<{ chain: string[] }>("/attestation", { alias: ALIAS });
  ok("attestation chain", `${attestation.chain.length} certificate(s)`);

  const device = new FiscalDevice(identity, { signer, transport: deviceTransport(caPem, reg.certificatePem), storage: new MemoryStorage() }, { baseUrl: url });
  const config = await device.getConfig();
  ok("GetConfig over mutual TLS with the keystore key as client identity", config.taxPayerName);

  await device.reconcile();
  await device.openDay();
  ok("OpenDay", `fiscal day ${device.getState()!.fiscalDayNo}`);

  const r1 = await device.submitReceipt({ currency: "USD", invoiceNo: "EMU-1", lines: [{ name: "Airtime", price: cents("5.00"), quantity: 2, taxId: 1, taxPercent: 15 }], payments: [{ moneyType: "MobileWallet", amount: 10 }] });
  const r2 = await device.submitReceipt({ currency: "USD", invoiceNo: "EMU-2", lines: [{ name: "Bread", price: cents("2.50"), quantity: 1, taxId: 3 }], payments: [{ moneyType: "Cash", amount: cents("2.50") }] });
  for (const [i, r] of [r1, r2].entries()) {
    const errs = r.response.validationErrors ?? [];
    if (errs.length) throw new Error(`receipt ${i + 1} validation errors: ${JSON.stringify(errs)}`);
    ok(`receipt ${r.receipt.receiptGlobalNo} accepted, signature verified by the simulator`, r.qrData ?? "");
  }
  if (r2.receipt.receiptGlobalNo !== r1.receipt.receiptGlobalNo + 1) throw new Error("global numbers not sequential");

  sim.faults.dropAfterSubmit = 1;
  let dropped = false;
  try {
    await device.submitReceipt({ currency: "USD", invoiceNo: "EMU-3", lines: [{ name: "Milk", price: 1, quantity: 1, taxId: 1, taxPercent: 15 }], payments: [{ moneyType: "Cash", amount: 1 }] });
  } catch (e) {
    dropped = e instanceof TransportError;
  }
  if (!dropped) throw new Error("expected a TransportError when the answer was dropped");
  const rec = await device.reconcile();
  if (rec.action !== "confirmed") throw new Error(`expected confirmed, got ${rec.action}`);
  ok("lost SubmitReceipt answer settled by reconcile()", "confirmed");

  await device.closeDay();
  let status = await device.getStatus();
  for (let i = 0; i < 30 && status.fiscalDayStatus !== "FiscalDayClosed"; i++) {
    await new Promise((r) => setTimeout(r, 50));
    status = await device.getStatus();
  }
  if (status.fiscalDayStatus !== "FiscalDayClosed") throw new Error(`day did not close: ${status.fiscalDayStatus} ${status.fiscalDayClosingErrorCode}`);
  ok("CloseDay signed by the keystore, day closed", `lastReceiptGlobalNo ${status.lastReceiptGlobalNo}`);

  console.log("\nAndroid emulator: the core ran a fiscal day with Android Keystore signing and mutual TLS from the device.");
} catch (e) {
  console.error("simulator log:", JSON.stringify(sim.log.slice(-6), null, 1));
  throw e;
} finally {
  await bridge("/delete", { alias: ALIAS }).catch(() => undefined);
  await sim.stop();
}
