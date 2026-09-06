/**
 * The SDK against the simulator over real mutual TLS: registration from a
 * CSR, the full day cycle, every validation code the simulator replays,
 * and fault injection. Each test registers its own device so no state
 * leaks between them.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { FdmsSimulator } from "../src/simulator/server.js";
import { FiscalDevice } from "../src/node/device.js";
import { registerDevice } from "../src/node/registration.js";
import { NodeTransport } from "../src/node/transport.js";
import { PemSigner } from "../src/node/pem-signer.js";
import { MemoryStorage } from "../src/core/storage.js";
import { TransportError } from "../src/core/transport.js";
import { FdmsApiError, type DeviceIdentity } from "../src/core/types.js";
import { cents } from "../src/core/money.js";
import { DayNotClosableError, type ReceiptInput } from "../src/core/device.js";
import { fdmsDateTime } from "../src/core/signing.js";

const SALE: ReceiptInput = {
  currency: "USD",
  invoiceNo: "INV-1",
  lines: [{ name: "Widget", price: cents("11.50"), quantity: 2, taxId: 1, taxPercent: 15 }],
  payments: [{ moneyType: "Cash", amount: 23 }],
};

let sim: FdmsSimulator;
let url: string;
let caPem: string;
let nextId = 600;

async function waitForStatus(fd: FiscalDevice, want: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const s = await fd.getStatus();
    if (s.fiscalDayStatus === want) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`status never became ${want}`);
}

/** Register a brand-new device and return a FiscalDevice for it. */
async function freshDevice() {
  const identity: DeviceIdentity = { deviceId: nextId++, serialNumber: `SIM${nextId}`, modelName: "Test", modelVersion: "1" };
  const reg = await registerDevice(identity, "SIMKEY01", {
    baseUrl: url,
    transport: new NodeTransport(undefined, { ca: caPem }),
  });
  const pems = { certificatePem: reg.certificatePem, privateKeyPem: reg.keys.privateKeyPem };
  const fd = new FiscalDevice(identity, pems, { baseUrl: url, ca: caPem });
  return { identity, pems, fd };
}

describe("simulator", () => {
  before(async () => {
    sim = await FdmsSimulator.create({ closeDelayMs: 30, activationKeys: ["SIMKEY01"] });
    ({ url, caPem } = await sim.start());
  });
  after(async () => {
    await sim.stop();
  });

  it("registers a device from a CSR over plain TLS and issues a certificate", async () => {
    const identity = { deviceId: 501, serialNumber: "SIM001", modelName: "Test", modelVersion: "1" };
    await assert.rejects(
      registerDevice(identity, "WRONGKEY", { baseUrl: url, transport: new NodeTransport(undefined, { ca: caPem }) }),
      (e: FdmsApiError) => e.status === 422,
    );
    const reg = await registerDevice(identity, "simkey01", {
      baseUrl: url,
      transport: new NodeTransport(undefined, { ca: caPem }),
    });
    assert.match(reg.certificatePem, /BEGIN CERTIFICATE/);
    assert.equal(reg.commonName, "ZIMRA-SIM001-0000000501");
    assert.ok(sim.devices.has(501));
  });

  it("rejects device calls without the issued client certificate", async () => {
    const { identity } = await freshDevice();
    const stranger = new FiscalDevice(identity, { certificatePem: "", privateKeyPem: "" }, { baseUrl: url, ca: caPem });
    await assert.rejects(stranger.getStatus(), (e: FdmsApiError) => e.status === 401);
  });

  it("rejects a certificate issued to a different device", async () => {
    const a = await freshDevice();
    const b = await freshDevice();
    const crossed = new FiscalDevice(a.identity, b.pems, { baseUrl: url, ca: caPem });
    await assert.rejects(crossed.getStatus(), (e: FdmsApiError) => e.status === 401 && /does not match/.test(e.message));
  });

  it("runs config, open, two receipts with QR data, close, and settles closed", async () => {
    const { fd, identity } = await freshDevice();
    const config = await fd.getConfig();
    assert.equal(config.applicableTaxes.length, 3);
    await fd.openDay();
    const r1 = await fd.submitReceipt(SALE);
    const r2 = await fd.submitReceipt({
      ...SALE,
      invoiceNo: "INV-2",
      lines: [{ name: "Exempt", price: 5, quantity: 1, taxId: 3 }],
      payments: [{ moneyType: "Card", amount: 5 }],
    });
    assert.deepEqual(r1.response.validationErrors, []);
    assert.deepEqual(r2.response.validationErrors, []);
    assert.equal(r1.receipt.receiptGlobalNo, 1);
    assert.equal(r2.receipt.receiptGlobalNo, 2);
    const id10 = String(identity.deviceId).padStart(10, "0");
    assert.match(r1.qrData!, new RegExp(`^https://fdmstest\\.zimra\\.co\\.zw/${id10}\\d{8}0000000001[0-9a-f]{16}$`));
    assert.ok(r1.response.receiptServerSignature.signature);
    await fd.closeDay();
    const closed = await waitForStatus(fd, "FiscalDayClosed");
    assert.equal(closed.lastFiscalDayNo, 1);
    assert.equal(closed.lastReceiptGlobalNo, 2);
    // A second day continues the global numbering.
    await fd.openDay();
    const r3 = await fd.submitReceipt(SALE);
    assert.equal(r3.receipt.receiptGlobalNo, 3);
    assert.equal(r3.receipt.receiptCounter, 1);
  });

  it("flags RCPT010 when the signature is wrong, and the day then cannot close", async () => {
    const { fd } = await freshDevice();
    await fd.openDay();
    const prepared = await fd.signReceipt(SALE);
    prepared.receipt.receiptDeviceSignature.signature = prepared.receipt.receiptDeviceSignature.signature.replace(/[A-Za-z]/, (c) => (c === "A" ? "B" : "A"));
    const res = await fd.submitPrepared(prepared);
    assert.deepEqual(res.response.validationErrors.map((e) => e.validationErrorCode), ["RCPT010"]);
    await assert.rejects(fd.closeDay(), DayNotClosableError);
    await fd.closeDay({ force: true });
    const s = await waitForStatus(fd, "FiscalDayOpened");
    assert.equal(s.fiscalDayClosingErrorCode, "ReceiptsWithValidationErrors");
  });

  it("flags RCPT011 and RCPT012 Red for wrong counters", async () => {
    const { fd } = await freshDevice();
    await fd.openDay();
    const state = fd.getState()!;
    fd.restoreState({ ...state, receiptGlobalNo: state.receiptGlobalNo + 5, receiptCounter: 3 });
    const res = await fd.submitReceipt(SALE);
    assert.deepEqual(
      res.response.validationErrors.map((e) => `${e.validationErrorCode}:${e.validationErrorColor}`),
      ["RCPT011:Red", "RCPT012:Red"],
    );
  });

  it("flags RCPT031 Yellow for a future date, RCPT030 Red for going backwards, and under-reports the last number", async () => {
    const { fd } = await freshDevice();
    await fd.openDay();
    const a = await fd.submitReceipt({ ...SALE, receiptDate: new Date(Date.now() + 3600_000) });
    assert.deepEqual(
      a.response.validationErrors.map((e) => `${e.validationErrorCode}:${e.validationErrorColor}`),
      ["RCPT031:Yellow"],
    );
    const b = await fd.submitReceipt({ ...SALE, invoiceNo: "INV-2", receiptDate: new Date() });
    assert.deepEqual(b.response.validationErrors.map((e) => e.validationErrorCode), ["RCPT030"]);
    assert.equal(fd.getState()!.redErrors?.length, 1);
    // The quirk: GetStatus reports the future-dated receipt, not the highest number.
    const s = await fd.getStatus();
    assert.equal(s.lastReceiptGlobalNo, a.receipt.receiptGlobalNo);
    assert.equal(b.receipt.receiptGlobalNo, a.receipt.receiptGlobalNo + 1);
  });

  it("flags RCPT014 Yellow for a receipt dated before the day opened", async () => {
    const { fd } = await freshDevice();
    await fd.openDay(undefined, new Date());
    const res = await fd.submitReceipt({ ...SALE, receiptDate: new Date(Date.now() - 3600_000) });
    assert.deepEqual(res.response.validationErrors.map((e) => e.validationErrorCode), ["RCPT014"]);
  });

  it("flags RCPT013 for a tax id outside the device tax table", async () => {
    const { fd } = await freshDevice();
    await fd.openDay();
    const res = await fd.submitReceipt({ ...SALE, lines: [{ ...SALE.lines[0]!, taxId: 99 }] });
    assert.deepEqual(res.response.validationErrors.map((e) => e.validationErrorCode), ["RCPT013"]);
  });

  it("bounces a close signed over the wrong date with BadCertificateSignature", async () => {
    const { fd } = await freshDevice();
    await fd.openDay();
    await fd.submitReceipt(SALE);
    const s = fd.getState()!;
    fd.restoreState({ ...s, fiscalDayDate: "2020-01-01" });
    await fd.closeDay();
    const st = await waitForStatus(fd, "FiscalDayOpened");
    assert.equal(st.fiscalDayClosingErrorCode, "BadCertificateSignature");
    // Retry with the right date closes it.
    fd.restoreState(s);
    await fd.closeDay();
    await waitForStatus(fd, "FiscalDayClosed");
  });

  it("recovers a close from server counters, as the CLI does without local state", async () => {
    const { fd, pems, identity } = await freshDevice();
    await fd.openDay();
    await fd.submitReceipt(SALE);
    await fd.submitReceipt({ ...SALE, invoiceNo: "INV-2" });
    const status = await fd.getStatus();
    assert.equal(status.fiscalDayCounter!.length, 3);
    assert.equal(status.fiscalDayDocumentQuantities![0]!.receiptQuantity, 2);
    const fresh = new FiscalDevice(identity, pems, { baseUrl: url, ca: caPem });
    fresh.restoreState({
      fiscalDayNo: status.lastFiscalDayNo!,
      fiscalDayDate: fdmsDateTime(new Date()).slice(0, 10),
      receiptCounter: 2,
      receiptGlobalNo: status.lastReceiptGlobalNo!,
      counters: status.fiscalDayCounter!,
    });
    await fresh.closeDay();
    await waitForStatus(fresh, "FiscalDayClosed");
  });

  it("refuses OpenDay while a day is open and SubmitReceipt while closed", async () => {
    const { fd } = await freshDevice();
    await fd.openDay();
    await assert.rejects(fd.openDay(), /FiscalDayOpened/);
    await fd.closeDay();
    await waitForStatus(fd, "FiscalDayClosed");
    fd.restoreState({ fiscalDayNo: 1, fiscalDayDate: "2026-01-01", receiptCounter: 0, receiptGlobalNo: 0, counters: [] });
    await assert.rejects(fd.submitReceipt(SALE), (e: FdmsApiError) => e.problem?.errorCode === "FDC02");
  });

  it("renews the certificate through IssueCertificate and the new one authenticates", async () => {
    const { fd, pems, identity } = await freshDevice();
    const renewed = await fd.renewCertificate();
    assert.match(renewed.certificatePem, /BEGIN CERTIFICATE/);
    assert.notEqual(renewed.certificatePem, pems.certificatePem);
    const withNew = new FiscalDevice(identity, { certificatePem: renewed.certificatePem, privateKeyPem: pems.privateKeyPem }, { baseUrl: url, ca: caPem });
    assert.equal((await withNew.getStatus()).fiscalDayStatus, "FiscalDayClosed");
  });

  describe("fault injection", () => {
    it("idempotent calls retry through dropped connections; more drops than retries surface as TransportError", async () => {
      const { fd } = await freshDevice();
      sim.faults.dropConnections = 2;
      await fd.ping(); // two retries by default
      sim.faults.dropConnections = 3;
      await assert.rejects(fd.ping(), TransportError);
      sim.faults.dropConnections = 0;
    });

    it("SubmitReceipt is never retried by the client", async () => {
      const { fd } = await freshDevice();
      await fd.openDay();
      sim.faults.dropConnections = 1;
      await assert.rejects(fd.submitReceipt(SALE), TransportError);
      sim.faults.dropConnections = 0;
    });

    it("5xx surfaces as FdmsApiError with the status", async () => {
      const { fd } = await freshDevice();
      sim.faults.serverErrors = 1;
      await assert.rejects(fd.ping(), (e: FdmsApiError) => e.status === 503);
    });

    it("a skewed Date header is learned by the client clock", async () => {
      const { fd } = await freshDevice();
      sim.faults.dateSkewMs = 2 * 3600_000;
      await fd.ping();
      sim.faults.dateSkewMs = 0;
      assert.ok(Math.abs(fd.clock.offsetMs - 2 * 3600_000) < 5000, String(fd.clock.offsetMs));
    });

    it("a lost SubmitReceipt answer is settled by reconcile() as confirmed", async () => {
      const { pems, identity } = await freshDevice();
      const storage = new MemoryStorage();
      const fd = new FiscalDevice(
        identity,
        { signer: new PemSigner(pems.privateKeyPem), transport: new NodeTransport(pems, { ca: caPem }), storage },
        { baseUrl: url },
      );
      await fd.openDay();
      sim.faults.dropAfterSubmit = 1;
      await assert.rejects(fd.submitReceipt(SALE), TransportError);
      const r = await fd.reconcile();
      assert.equal(r.action, "confirmed");
      const next = await fd.submitReceipt({ ...SALE, invoiceNo: "INV-2" });
      assert.deepEqual(next.response.validationErrors, []);
      assert.equal(next.receipt.receiptGlobalNo, 2);
      await fd.closeDay();
      await waitForStatus(fd, "FiscalDayClosed");
    });
  });
});
