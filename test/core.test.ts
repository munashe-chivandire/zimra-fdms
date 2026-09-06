/**
 * The portable core: hashes and bytes against node:crypto, the pure CSR
 * builder against @peculiar/x509, and a whole fiscal day driven through
 * FiscalDevice with an injected Signer and a scripted Transport, inside a VM
 * context that has no Buffer, process or require.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as x509 from "@peculiar/x509";

import { sha256, sha256Base64 } from "../src/core/sha256.js";
import { md5 } from "../src/core/md5.js";
import { toBase64, fromBase64, utf8Bytes, utf8String, toHex, pemToDer } from "../src/core/bytes.js";
import { derOid, derInteger } from "../src/core/asn1.js";
import { buildCsr, deviceCommonName } from "../src/core/csr.js";
import { derToP1363, p1363ToDer, type Signer } from "../src/core/signer.js";
import { ServerCorrectedClock } from "../src/core/clock.js";
import { FetchTransport } from "../src/core/fetch-transport.js";
import {
  FdmsClient,
  TransportError,
  isNetworkError,
  type Transport,
  type TransportRequest,
} from "../src/core/transport.js";
import { FiscalDevice } from "../src/core/device.js";
import { receiptSigningString } from "../src/core/signing.js";
import { PemSigner, generatePemSigner } from "../src/node/pem-signer.js";
import { FdmsApiError } from "../src/core/types.js";
import { cents } from "../src/core/money.js";

x509.cryptoProvider.set(webcrypto as Crypto);

const owned = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

describe("bytes and hashes match node:crypto", () => {
  const strings = [
    "", "a", "abc", "ZIMRA-GOKOSDK001-0000037367", "æøå 漢字 🎉",
    "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65), "y".repeat(1000),
  ];

  it("utf8 round-trips and matches Buffer", () => {
    for (const s of strings) {
      assert.equal(utf8String(utf8Bytes(s)), s);
      assert.equal(toHex(utf8Bytes(s)), Buffer.from(s, "utf-8").toString("hex"));
    }
  });

  it("sha256 over strings of every padding length", () => {
    for (const s of strings) {
      assert.equal(sha256Base64(s), createHash("sha256").update(s, "utf-8").digest("base64"));
    }
  });

  it("sha256, md5 and base64 over random bytes", () => {
    for (let i = 0; i < 200; i++) {
      const b = randomBytes(Math.floor(Math.random() * 300));
      assert.equal(toBase64(sha256(b)), createHash("sha256").update(b).digest("base64"));
      assert.equal(toHex(md5(b)), createHash("md5").update(b).digest("hex"));
      assert.equal(toBase64(b), b.toString("base64"));
      assert.equal(toHex(fromBase64(b.toString("base64"))), b.toString("hex"));
    }
  });

  it("base64 decode tolerates whitespace and PEM line breaks", () => {
    const b = randomBytes(100);
    const wrapped = b.toString("base64").replace(/(.{20})/g, "$1\n ");
    assert.equal(toHex(fromBase64(wrapped)), b.toString("hex"));
  });
});

describe("DER primitives", () => {
  it("encodes the OIDs the CSR needs", () => {
    assert.equal(toHex(derOid("2.5.4.3")), "0603550403");
    assert.equal(toHex(derOid("1.2.840.10045.4.3.2")), "06082a8648ce3d040302");
    assert.equal(toHex(derOid("1.2.840.10045.2.1")), "06072a8648ce3d0201");
  });
  it("encodes integers with a sign byte when needed", () => {
    assert.equal(toHex(derInteger(0)), "020100");
    assert.equal(toHex(derInteger(127)), "02017f");
    assert.equal(toHex(derInteger(128)), "02020080");
    assert.equal(toHex(derInteger(256)), "02020100");
  });
});

describe("signature format conversion", () => {
  it("DER to P1363 and back is lossless, including short r/s", () => {
    for (let i = 0; i < 50; i++) {
      const r = randomBytes(32);
      const s = randomBytes(32);
      if (i % 5 === 0) r[0] = 0; // leading zero must survive the round trip
      const p1363 = Buffer.concat([r, s]);
      assert.equal(toHex(derToP1363(p1363ToDer(p1363))), p1363.toString("hex"));
    }
  });
});

describe("buildCsr", () => {
  it("matches @peculiar/x509 on the signed body and verifies", async () => {
    const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
    const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
    const pem = x509.PemConverter.encode(
      await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
      "PRIVATE KEY",
    );
    const cn = deviceCommonName("GOKOSDK001", 37367);

    const refCsr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: `CN=${cn}`,
      keys,
      signingAlgorithm: alg,
    });
    const ref = new Uint8Array(refCsr.rawData);
    const ours = pemToDer(await buildCsr(new PemSigner(pem), cn));

    // Outer SEQUENCE header is 3 bytes for this size; the info block is the
    // first element. Signatures are randomised, so compare only the info.
    const infoLen = (d: Uint8Array) => 2 + (d[4]! & 0x7f) + (d[4]! & 0x80 ? d[5]! : 0);
    assert.equal(toHex(ours.subarray(3, 3 + infoLen(ours))), toHex(ref.subarray(3, 3 + infoLen(ref))));

    const parsed = new x509.Pkcs10CertificateRequest(ours);
    assert.equal(parsed.subject, `CN=${cn}`);
    assert.equal(await parsed.verify(), true);
  });

  it("signs the CSR with a Signer that never exposes key material", async () => {
    // A signer whose key lives in a closure, as it would in a keystore.
    const keys = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const signer: Signer = {
      sign: async (d) =>
        p1363ToDer(
          new Uint8Array(
            await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, owned(d)),
          ),
        ),
      publicKeySpki: async () => new Uint8Array(await webcrypto.subtle.exportKey("spki", keys.publicKey)),
    };
    const csr = new x509.Pkcs10CertificateRequest(pemToDer(await buildCsr(signer, "ZIMRA-HW-0000000001")));
    assert.equal(await csr.verify(), true);
  });
});

describe("ServerCorrectedClock", () => {
  it("learns an offset and applies it", () => {
    let local = 1_000_000;
    const clock = new ServerCorrectedClock({ now: () => new Date(local) });
    assert.equal(clock.confidence, 0);
    clock.learn(new Date(local + 7_200_000), 200); // device two hours slow
    assert.equal(clock.confidence, 1);
    assert.equal(clock.offsetMs, 7_200_100);
    local += 1000;
    assert.equal(clock.now().getTime(), local + 7_200_100);
  });
  it("smooths later samples instead of jumping", () => {
    const clock = new ServerCorrectedClock({ now: () => new Date(0) });
    clock.learn(new Date(1000));
    clock.learn(new Date(3000));
    assert.equal(clock.offsetMs, 2000);
    clock.learn(new Date(5000));
    assert.equal(clock.offsetMs, 3000);
  });
});

describe("FdmsClient", () => {
  const device = { deviceId: 7, serialNumber: "S", modelName: "M", modelVersion: "1" };

  it("builds headers and paths, parses JSON, feeds the clock", async () => {
    let seen: TransportRequest | undefined;
    const transport: Transport = {
      request: async (req) => {
        seen = req;
        return {
          status: 200,
          headers: { date: "Mon, 07 Sep 2026 10:00:00 GMT", operationid: "op1" },
          text: '{"ok":1}',
        };
      },
    };
    const dates: Date[] = [];
    const c = new FdmsClient(device, transport, {
      environment: "production",
      onServerDate: (d) => dates.push(d),
    });
    const res = await c.request<{ ok: number }>("POST", c.devicePath("Ping"), { a: 1 });
    assert.deepEqual(res, { ok: 1 });
    assert.equal(seen!.url, "https://fdmsapi.zimra.co.zw/Device/v1/7/Ping");
    assert.equal(seen!.headers["DeviceModelName"], "M");
    assert.equal(seen!.headers["Content-Type"], "application/json");
    assert.equal(seen!.body, '{"a":1}');
    assert.equal(dates[0]!.toISOString(), "2026-09-07T10:00:00.000Z");
  });

  it("turns problem details into FdmsApiError with the operationId", async () => {
    const transport: Transport = {
      request: async () => ({
        status: 422,
        headers: { operationid: "0HN5" },
        text: '{"errorCode":"DEV01","detail":"nope"}',
      }),
    };
    const c = new FdmsClient(device, transport);
    await assert.rejects(
      c.request("GET", "/x"),
      (e: FdmsApiError) => e.status === 422 && e.operationId === "0HN5" && /nope/.test(e.message),
    );
  });

  it("classifies TransportError as a network failure", () => {
    assert.equal(isNetworkError(new TransportError("boom")), true);
    assert.equal(isNetworkError(new FdmsApiError(400, undefined)), false);
  });
});

describe("FetchTransport", () => {
  it("maps a fetch response and lower-cases headers", async () => {
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, "POST");
      return new Response("hi", { status: 201, headers: { OperationID: "z", Date: "x" } });
    }) as typeof fetch;
    const res = await new FetchTransport(fakeFetch).request({
      method: "POST",
      url: "https://a/b",
      headers: {},
      body: "{}",
      timeoutMs: 1000,
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers["operationid"], "z");
    assert.equal(res.text, "hi");
  });
  it("wraps fetch failures in TransportError", async () => {
    const failing = (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch;
    await assert.rejects(
      new FetchTransport(failing).request({ method: "GET", url: "https://a", headers: {}, timeoutMs: 10 }),
      TransportError,
    );
  });
});

/** A scripted FDMS that verifies every device signature it receives. */
function fakeFdms(spkiPem: string) {
  const calls: { path: string; body?: unknown }[] = [];
  let status = "FiscalDayClosed";
  let globalNo = 41;
  const pub = webcrypto.subtle.importKey(
    "spki",
    owned(pemToDer(spkiPem)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verify = async (canonical: string, sigB64: string) =>
    webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await pub,
      owned(derToP1363(fromBase64(sigB64))),
      owned(utf8Bytes(canonical)),
    );
  let prevHash: string | undefined;
  const transport: Transport = {
    request: async (req) => {
      const path = new URL(req.url).pathname.split("/").pop()!;
      const body = req.body ? JSON.parse(req.body) : undefined;
      calls.push({ path, body });
      const reply = (obj: unknown) => ({
        status: 200,
        headers: { date: new Date().toUTCString(), operationid: "op" },
        text: JSON.stringify(obj),
      });
      switch (path) {
        case "GetStatus":
          return reply({ fiscalDayStatus: status, lastReceiptGlobalNo: globalNo });
        case "OpenDay":
          status = "FiscalDayOpened";
          return reply({ fiscalDayNo: 9, operationID: "op" });
        case "SubmitReceipt": {
          const r = body.receipt;
          const canonical = receiptSigningString(7, r, prevHash);
          assert.equal(r.receiptDeviceSignature.hash, sha256Base64(canonical));
          assert.equal(await verify(canonical, r.receiptDeviceSignature.signature), true, "receipt signature");
          prevHash = r.receiptDeviceSignature.hash;
          globalNo = r.receiptGlobalNo;
          return reply({
            receiptID: 1,
            serverDate: new Date().toISOString(),
            receiptServerSignature: { hash: "", signature: "" },
            operationID: "op",
          });
        }
        case "CloseDay":
          status = "FiscalDayCloseInitiated";
          return reply({ operationID: "op" });
        default:
          return { status: 404, headers: {}, text: "" };
      }
    },
  };
  return { transport, calls, verify };
}

describe("FiscalDevice through injected Signer and Transport", () => {
  const device = { deviceId: 7, serialNumber: "S", modelName: "M", modelVersion: "1" };

  it("runs open, two chained receipts and close, all signatures verifying", async () => {
    const { signer, publicKeyPem } = await generatePemSigner();
    const fdms = fakeFdms(publicKeyPem);
    const fd = new FiscalDevice(device, { signer, transport: fdms.transport });

    await fd.openDay();
    const r1 = await fd.submitReceipt({
      currency: "USD",
      invoiceNo: "1",
      lines: [{ name: "a", price: cents("11.50"), quantity: 2, taxId: 3, taxPercent: 15 }],
      payments: [{ moneyType: "Cash", amount: 23 }],
    });
    const r2 = await fd.submitReceipt({
      currency: "USD",
      invoiceNo: "2",
      lines: [{ name: "b", price: 5, quantity: 1, taxId: 1, taxPercent: null }],
      payments: [{ moneyType: "Card", amount: 5 }],
    });
    assert.equal(r1.receipt.receiptGlobalNo, 42);
    assert.equal(r2.receipt.receiptGlobalNo, 43);
    assert.equal(fd.getState()!.previousReceiptHash, r2.receipt.receiptDeviceSignature.hash);
    assert.ok(fd.clock.confidence >= 3, "clock learned from Date headers");
    await fd.closeDay();
    assert.equal(fd.getState(), undefined);
    assert.deepEqual(
      fdms.calls.map((c) => c.path),
      ["GetStatus", "OpenDay", "SubmitReceipt", "SubmitReceipt", "CloseDay"],
    );
  });

  it("stamps receipts with server time when the device clock is wrong", async () => {
    const { signer, publicKeyPem } = await generatePemSigner();
    const fdms = fakeFdms(publicKeyPem);
    const twoHoursSlow = { now: () => new Date(Date.now() - 7_200_000) };
    const fd = new FiscalDevice(device, { signer, transport: fdms.transport, clock: twoHoursSlow });
    await fd.openDay();
    const { receipt } = await fd.submitReceipt({
      currency: "USD",
      invoiceNo: "1",
      lines: [{ name: "a", price: 1, quantity: 1, taxId: 1 }],
      payments: [{ moneyType: "Cash", amount: 1 }],
    });
    const stamped = new Date(receipt.receiptDate).getTime();
    // HTTP dates resolve to whole seconds, so allow a little slack.
    assert.ok(
      Math.abs(stamped - Date.now()) < 60_000,
      `receiptDate ${receipt.receiptDate} should be near now, not two hours back`,
    );
    assert.ok(Math.abs(fd.clock.offsetMs - 7_200_000) < 5_000);
  });

  it("renews the certificate with the same key", async () => {
    const { signer, publicKeyPem } = await generatePemSigner();
    const fdms = fakeFdms(publicKeyPem);
    const orig = fdms.transport.request;
    fdms.transport.request = async (req) => {
      if (req.url.endsWith("IssueCertificate")) {
        const csr = new x509.Pkcs10CertificateRequest(pemToDer(JSON.parse(req.body!).certificateRequest));
        assert.equal(await csr.verify(), true);
        assert.equal(toHex(new Uint8Array(csr.publicKey.rawData)), toHex(pemToDer(publicKeyPem)));
        return { status: 200, headers: {}, text: JSON.stringify({ certificate: "CERT", operationID: "op" }) };
      }
      return orig(req);
    };
    const fd = new FiscalDevice(device, { signer, transport: fdms.transport });
    const res = await fd.renewCertificate();
    assert.equal(res.certificatePem, "CERT");
  });
});

describe("core runs without Node globals", () => {
  const SourceTextModule = (vm as unknown as { SourceTextModule?: typeof vm.SourceTextModule }).SourceTextModule;

  it(
    "drives a day inside a vm context with no Buffer, process or require",
    { skip: SourceTextModule ? false : "needs node --experimental-vm-modules" },
    async () => {
      // dist/core is what other runtimes load. The context gets only what
      // ES2020 guarantees, plus a Signer and Transport handed in from outside.
      const { signer, publicKeyPem } = await generatePemSigner();
      const fdms = fakeFdms(publicKeyPem);
      const context = vm.createContext({
        signer, transport: fdms.transport,
        Date, Math, JSON, Promise, Error, TypeError, RangeError, Object, Array, Map, Set, String, Number,
        Uint8Array, Int16Array, Uint32Array, ArrayBuffer, Symbol, structuredClone, URL,
        setTimeout, clearTimeout, AbortController,
      });
      assert.equal(
        vm.runInContext("typeof Buffer + typeof process + typeof require + typeof fetch", context),
        "undefinedundefinedundefinedundefined",
      );

      const modules = new Map<string, vm.SourceTextModule>();
      const root = new URL("../dist/core/", import.meta.url);
      const load = (spec: string, from = root.href): vm.SourceTextModule => {
        const url = new URL(spec, from).href;
        let m = modules.get(url);
        if (!m) {
          m = new SourceTextModule!(readFileSync(new URL(url), "utf-8"), { context, identifier: url });
          modules.set(url, m);
        }
        return m;
      };
      const entry = load("index.js");
      await entry.link((spec, referrer) => load(spec, referrer.identifier));
      await entry.evaluate();
      const core = entry.namespace as typeof import("../src/core/index.js");

      const fd = new core.FiscalDevice(
        { deviceId: 7, serialNumber: "S", modelName: "M", modelVersion: "1" },
        { signer, transport: fdms.transport },
      );
      await fd.openDay();
      const { receipt, qrData } = await fd.submitReceipt({
        currency: "ZWG",
        invoiceNo: "9",
        lines: [{ name: "a", price: 100, quantity: 1, taxId: 3, taxPercent: 15 }],
        payments: [{ moneyType: "Cash", amount: 100 }],
      });
      assert.equal(receipt.receiptGlobalNo, 42);
      assert.equal(qrData, undefined); // no GetConfig, so no qrUrl
      await fd.closeDay();
    },
  );
});
