/**
 * A local FDMS.
 *
 * Implements the Device API the SDK uses and replays the validation
 * behaviour observed against ZIMRA's test environment: signature and hash
 * checks (RCPT010), counter and global-number sequencing (RCPT011,
 * RCPT012), receipt-date rules (RCPT014, RCPT030, RCPT031), the quirk that
 * GetStatus reports the number of the receipt with the latest date rather
 * than the highest issued, and the asynchronous CloseDay that ends in
 * FiscalDayClosed or bounces back with a fiscalDayClosingErrorCode.
 *
 * It is not ZIMRA. Passing here means the SDK is internally consistent; the
 * nightly run against the real test environment is still the authority.
 */
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { webcrypto } from "node:crypto";
import { SimulatorCa, certificateCommonName, certificatePublicKey } from "./ca.js";
import { accumulateCounters } from "../core/device.js";
import { fdmsDateTime, fiscalDaySigningString, receiptSigningString, toCents } from "../core/signing.js";
import { sha256Base64 } from "../core/sha256.js";
import { derToP1363, p1363ToDer } from "../core/signer.js";
import { fromBase64, toBase64, utf8Bytes } from "../core/bytes.js";
import type { FiscalDayCounter, FiscalDayStatus, Receipt, ValidationError } from "../core/types.js";

export interface SimulatorOptions {
  port?: number;
  host?: string;
  /**
   * Extra names for the server certificate, e.g. "10.0.2.2" so an Android
   * emulator can reach the host. localhost and 127.0.0.1 are always included.
   */
  hosts?: string[];
  /** Activation keys accepted by RegisterDevice. Default: any 8 characters. */
  activationKeys?: string[];
  /** Delay before a CloseDay settles. Default 300 ms. */
  closeDelayMs?: number;
  /** How far ahead of server time a receiptDate may be before RCPT031. Default 5 minutes. */
  futureToleranceMs?: number;
  /** Tax table returned by GetConfig. Default: 15% VAT (id 1), 0% (id 2), exempt (id 3). */
  taxes?: { taxID: number; taxName: string; taxPercent: number | null; taxValidFrom?: string }[];
  taxPayerName?: string;
  taxPayerTIN?: string;
  qrUrl?: string;
}

/** Faults are consumed as they fire, so a test sets exactly what it wants. */
export interface Faults {
  /** Destroy the next N connections before answering. */
  dropConnections: number;
  /** Answer the next N requests with HTTP 503. */
  serverErrors: number;
  /** Add this delay to every response. */
  delayMs: number;
  /** Offset applied to the Date header, to simulate a wrong server clock or test the client's correction. */
  dateSkewMs: number;
  /** Accept the next N SubmitReceipts and then drop the socket, so the client never sees the answer. */
  dropAfterSubmit: number;
}

export interface SimReceipt {
  receipt: Receipt;
  receiptID: number;
  validationErrors: ValidationError[];
  serverDate: string;
}

export interface SimDay {
  fiscalDayNo: number;
  opened: string;
  receipts: SimReceipt[];
  counters: FiscalDayCounter[];
  closed?: string;
}

export interface SimDevice {
  deviceId: number;
  serialNumber: string;
  commonName: string;
  certificatePem?: string;
  status: FiscalDayStatus;
  closingErrorCode?: string;
  days: SimDay[];
  nextReceiptId: number;
}

class HttpError extends Error {
  constructor(public readonly status: number, public readonly errorCode: string, detail: string) {
    super(detail);
  }
}

const RED = "Red";
const YELLOW = "Yellow";

export class FdmsSimulator {
  readonly devices = new Map<number, SimDevice>();
  readonly faults: Faults = { dropConnections: 0, serverErrors: 0, delayMs: 0, dateSkewMs: 0, dropAfterSubmit: 0 };
  /** Every request seen, oldest first. */
  readonly log: { method: string; path: string; status: number }[] = [];

  private server?: Server;
  private opCounter = 0;
  private readonly options: Required<Omit<SimulatorOptions, "activationKeys" | "port" | "host" | "hosts">> &
    Pick<SimulatorOptions, "activationKeys" | "port" | "host" | "hosts">;

  private constructor(readonly ca: SimulatorCa, options: SimulatorOptions) {
    this.options = {
      closeDelayMs: 300,
      futureToleranceMs: 5 * 60_000,
      taxes: [
        { taxID: 1, taxName: "Standard rated 15%", taxPercent: 15 },
        { taxID: 2, taxName: "Zero rated 0%", taxPercent: 0 },
        { taxID: 3, taxName: "Exempt", taxPercent: null },
      ],
      taxPayerName: "Simulated Taxpayer",
      taxPayerTIN: "2000000000",
      qrUrl: "https://fdmstest.zimra.co.zw",
      ...options,
    };
  }

  static async create(options: SimulatorOptions = {}): Promise<FdmsSimulator> {
    return new FdmsSimulator(await SimulatorCa.create(), options);
  }

  /** Start listening. Returns the base URL to point the SDK at. */
  async start(): Promise<{ url: string; port: number; caPem: string }> {
    const host = this.options.host ?? "127.0.0.1";
    const identity = await this.ca.serverIdentity(["localhost", ...(this.options.hosts ?? [])]);
    this.server = createServer(
      {
        key: identity.privateKeyPem,
        cert: identity.certificatePem,
        ca: this.ca.caPem,
        requestCert: true,
        // Public endpoints have no client certificate; device endpoints
        // check socket.authorized themselves.
        rejectUnauthorized: false,
      },
      (req, res) => void this.handle(req, res),
    );
    // Handshake failures never reach the request handler; keep them in the log.
    this.server.on("tlsClientError", (err, socket) => {
      this.log.push({ method: "TLS", path: `${socket.remoteAddress ?? "?"} ${err.message}`, status: 0 });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.options.port ?? 0, host, resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // 127.0.0.1 rather than localhost: Node 18 resolves localhost to ::1 first
    // and does not fall back to IPv4. The certificate carries both.
    return { url: `https://127.0.0.1:${port}`, port, caPem: this.ca.caPem };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
  }

  /** Register a device without going through RegisterDevice (test setup). */
  addDevice(deviceId: number, serialNumber: string): SimDevice {
    const d: SimDevice = {
      deviceId,
      serialNumber,
      commonName: `ZIMRA-${serialNumber}-${String(deviceId).padStart(10, "0")}`,
      status: "FiscalDayClosed",
      days: [],
      nextReceiptId: 1,
    };
    this.devices.set(deviceId, d);
    return d;
  }

  // -- request plumbing ----------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const socket = req.socket as TLSSocket;
    const entry = { method: req.method ?? "", path: req.url ?? "", status: 0 };
    this.log.push(entry);

    if (this.faults.dropConnections > 0) {
      this.faults.dropConnections--;
      socket.destroy();
      return;
    }
    if (this.faults.delayMs > 0) await new Promise((r) => setTimeout(r, this.faults.delayMs));

    const operationId = `SIM${String(++this.opCounter).padStart(6, "0")}`;
    const send = (status: number, body: unknown) => {
      entry.status = status;
      res.writeHead(status, {
        "Content-Type": "application/json",
        Date: new Date(Date.now() + this.faults.dateSkewMs).toUTCString(),
        operationID: operationId,
      });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    if (this.faults.serverErrors > 0) {
      this.faults.serverErrors--;
      send(503, { title: "Service Unavailable", status: 503 });
      return;
    }

    try {
      const body = await readBody(req);
      const url = new URL(req.url ?? "/", "https://localhost");
      const out = await this.route(req.method ?? "GET", url, body, socket, operationId);
      if (out.dropSocket) {
        socket.destroy();
        return;
      }
      send(200, out.body);
    } catch (err) {
      if (err instanceof HttpError) {
        send(err.status, { title: err.errorCode, status: err.status, errorCode: err.errorCode, detail: err.message });
      } else {
        send(500, { title: "Internal", status: 500, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async route(
    method: string,
    url: URL,
    body: string,
    socket: TLSSocket,
    operationID: string,
  ): Promise<{ body: unknown; dropSocket?: boolean }> {
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "Public" && parts[1] === "v1") {
      if (parts[2] === "GetServerCertificate" && method === "GET") {
        return { body: { certificate: [this.ca.caPem] } };
      }
      const deviceId = Number(parts[2]);
      if (parts[3] === "RegisterDevice" && method === "POST") {
        return { body: await this.registerDevice(deviceId, JSON.parse(body), operationID) };
      }
      throw new HttpError(404, "NotFound", `No such endpoint ${url.pathname}`);
    }

    if (parts[0] !== "Device" || parts[1] !== "v1") {
      throw new HttpError(404, "NotFound", `No such endpoint ${url.pathname}`);
    }
    const deviceId = Number(parts[2]);
    const endpoint = parts[3] ?? "";
    const device = this.devices.get(deviceId);
    if (!device) throw new HttpError(401, "DEV01", `Device ${deviceId} is not registered`);

    // Mutual TLS: the client certificate must be one this CA issued to this device.
    if (!socket.authorized) throw new HttpError(401, "Unauthorized", `Client certificate rejected: ${socket.authorizationError}`);
    const peer = socket.getPeerCertificate();
    const cn = certificateCommonName(new Uint8Array(peer.raw));
    if (cn !== device.commonName) {
      throw new HttpError(401, "Unauthorized", `Certificate CN ${cn} does not match device ${deviceId}`);
    }
    const publicKey = await certificatePublicKey(new Uint8Array(peer.raw));

    const parsed = body ? JSON.parse(body) : undefined;
    switch (`${method} ${endpoint}`) {
      case "GET GetConfig":
        return { body: this.getConfig(device, operationID) };
      case "GET GetStatus":
        return { body: this.getStatus(device, operationID) };
      case "POST Ping":
        return { body: { reportingFrequency: 5, operationID } };
      case "POST OpenDay":
        return { body: this.openDay(device, parsed, operationID) };
      case "POST SubmitReceipt": {
        const out = await this.submitReceipt(device, parsed, publicKey, operationID);
        if (this.faults.dropAfterSubmit > 0) {
          this.faults.dropAfterSubmit--;
          return { body: out, dropSocket: true };
        }
        return { body: out };
      }
      case "POST CloseDay":
        return { body: await this.closeDay(device, parsed, publicKey, operationID) };
      case "POST IssueCertificate": {
        const issued = await this.ca.issueFromCsr(parsed.certificateRequest);
        device.certificatePem = issued.certificatePem;
        return { body: { operationID, certificate: issued.certificatePem } };
      }
      default:
        throw new HttpError(404, "NotFound", `No such endpoint ${url.pathname}`);
    }
  }

  // -- endpoints -----------------------------------------------------------

  private async registerDevice(
    deviceId: number,
    body: { certificateRequest: string; activationKey: string },
    operationID: string,
  ) {
    const key = body.activationKey ?? "";
    const accepted = this.options.activationKeys
      ? this.options.activationKeys.some((k) => k.toLowerCase() === key.toLowerCase())
      : key.length === 8;
    if (!accepted) throw new HttpError(422, "DEV04", "Activation key is not valid");

    let issued: { certificatePem: string; commonName: string };
    try {
      issued = await this.ca.issueFromCsr(body.certificateRequest);
    } catch (e) {
      throw new HttpError(422, "DEV05", `Certificate request rejected: ${e instanceof Error ? e.message : e}`);
    }
    const m = /^ZIMRA-(.+)-(\d{10})$/.exec(issued.commonName);
    if (!m || Number(m[2]) !== deviceId) {
      throw new HttpError(422, "DEV05", `CSR subject CN ${issued.commonName} is not ZIMRA-{serial}-${String(deviceId).padStart(10, "0")}`);
    }
    const device = this.devices.get(deviceId) ?? this.addDevice(deviceId, m[1]!);
    device.certificatePem = issued.certificatePem;
    return { operationID, certificate: issued.certificatePem };
  }

  private getConfig(device: SimDevice, operationID: string) {
    return {
      operationID,
      taxPayerName: this.options.taxPayerName,
      taxPayerTIN: this.options.taxPayerTIN,
      vatNumber: "220000000",
      deviceSerialNo: device.serialNumber,
      deviceBranchName: "Simulator",
      deviceBranchAddress: { province: "Harare", city: "Harare", street: "Samora Machel Ave", houseNo: "1" },
      deviceBranchContacts: { phoneNo: "0000", email: "sim@example.invalid" },
      deviceOperatingMode: "Online",
      taxPayerDayMaxHrs: 24,
      applicableTaxes: this.options.taxes.map((t) => ({ taxValidFrom: "2024-01-01", ...t })),
      certificateValidTill: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      qrUrl: this.options.qrUrl,
      taxpayerDayEndNotificationHrs: 20,
    };
  }

  private getStatus(device: SimDevice, operationID: string) {
    const all = device.days.flatMap((d) => d.receipts);
    // The quirk: the receipt with the latest receiptDate, not the highest number.
    const latest = [...all].sort((a, b) => (a.receipt.receiptDate < b.receipt.receiptDate ? 1 : -1))[0];
    const day = device.days[device.days.length - 1];
    return {
      operationID,
      fiscalDayStatus: device.status,
      fiscalDayReconciliationMode: "Auto",
      fiscalDayServerSignature: null,
      fiscalDayClosed: day?.closed ?? null,
      fiscalDayCounter: day && device.status !== "FiscalDayClosed" ? day.counters : [],
      fiscalDayDocumentQuantities: day
        ? summarise(day.receipts.map((r) => r.receipt))
        : [],
      lastReceiptGlobalNo: latest?.receipt.receiptGlobalNo ?? 0,
      lastFiscalDayNo: day?.fiscalDayNo ?? 0,
      fiscalDayClosingErrorCode: device.closingErrorCode ?? null,
    };
  }

  private openDay(device: SimDevice, body: { fiscalDayNo?: number | null; fiscalDayOpened: string }, operationID: string) {
    if (device.status !== "FiscalDayClosed") {
      throw new HttpError(422, "FDC01", "Fiscal day is already opened");
    }
    const last = device.days[device.days.length - 1]?.fiscalDayNo ?? 0;
    const fiscalDayNo = body.fiscalDayNo ?? last + 1;
    if (fiscalDayNo !== last + 1) {
      throw new HttpError(422, "FDC03", `Fiscal day number must be ${last + 1}`);
    }
    device.days.push({ fiscalDayNo, opened: body.fiscalDayOpened, receipts: [], counters: [] });
    device.status = "FiscalDayOpened";
    device.closingErrorCode = undefined;
    return { operationID, fiscalDayNo };
  }

  private async submitReceipt(
    device: SimDevice,
    body: { receipt: Receipt },
    publicKey: CryptoKey,
    operationID: string,
  ) {
    if (device.status !== "FiscalDayOpened") {
      throw new HttpError(422, "FDC02", "Fiscal day is not opened");
    }
    const day = device.days[device.days.length - 1]!;
    const r = body.receipt;
    const errors: ValidationError[] = [];
    const err = (code: string, colour: string, text: string) =>
      errors.push({ validationErrorCode: code, validationErrorColor: colour, validationErrorDescription: text });

    // Sequencing.
    const expectedCounter = day.receipts.length + 1;
    if (r.receiptCounter !== expectedCounter) {
      err("RCPT011", RED, `Receipt counter is not sequential (expected ${expectedCounter})`);
    }
    const highest = Math.max(0, ...device.days.flatMap((d) => d.receipts.map((x) => x.receipt.receiptGlobalNo)));
    if (r.receiptGlobalNo !== highest + 1) {
      err("RCPT012", RED, "Receipt global number is not sequential");
    }

    // Dates.
    const prev = day.receipts[day.receipts.length - 1];
    if (prev && r.receiptDate <= prev.receipt.receiptDate) {
      err("RCPT030", RED, "Receipt date is earlier than the previous receipt date");
    }
    if (r.receiptDate < day.opened) {
      err("RCPT014", YELLOW, "Receipt date is before the fiscal day was opened");
    }
    const serverNow = fdmsDateTime(new Date(Date.now() + this.options.futureToleranceMs));
    if (r.receiptDate > serverNow) {
      err("RCPT031", YELLOW, "Receipt date is in the future");
    }

    // Signature over the canonical string the SDK must reproduce exactly.
    const canonical = receiptSigningString(device.deviceId, r, prev?.receipt.receiptDeviceSignature.hash);
    const hash = sha256Base64(canonical);
    let verified = false;
    if (r.receiptDeviceSignature?.hash === hash) {
      try {
        verified = await webcrypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          publicKey,
          new Uint8Array(derToP1363(fromBase64(r.receiptDeviceSignature.signature))),
          new Uint8Array(utf8Bytes(canonical)),
        );
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      err("RCPT010", RED, "Receipt device signature is not valid");
    }

    // Totals.
    const linesTotal = r.receiptLines.reduce((s, l) => s + toCents(l.receiptLineTotal), 0);
    const taxTotal = r.receiptTaxes.reduce((s, t) => s + toCents(t.taxAmount), 0);
    const expectedTotal = r.receiptLinesTaxInclusive ? linesTotal : linesTotal + taxTotal;
    if (toCents(r.receiptTotal) !== expectedTotal) {
      err("RCPT020", RED, "Receipt total does not match the lines");
    }
    const paid = r.receiptPayments.reduce((s, p) => s + toCents(p.paymentAmount), 0);
    if (paid !== toCents(r.receiptTotal)) {
      err("RCPT021", RED, "Payments do not equal the receipt total");
    }
    for (const t of r.receiptTaxes) {
      if (!this.options.taxes.some((x) => x.taxID === t.taxID)) {
        err("RCPT013", RED, `Tax ID ${t.taxID} is not in the device tax table`);
      }
    }

    // Accepted regardless of colour; Red errors make the day unclosable.
    const serverDate = new Date().toISOString().slice(0, 19);
    const stored: SimReceipt = { receipt: r, receiptID: device.nextReceiptId++, validationErrors: errors, serverDate };
    day.receipts.push(stored);
    accumulateCounters(day.counters, r);

    const serverCanonical = `${r.receiptGlobalNo}${serverDate}${hash}`;
    const serverSig = await this.ca.sign(utf8Bytes(serverCanonical));
    return {
      operationID,
      receiptID: stored.receiptID,
      serverDate,
      receiptServerSignature: {
        hash: sha256Base64(serverCanonical),
        signature: toBase64(serverSig),
        certificateThumbprint: await this.ca.thumbprint(),
      },
      validationErrors: errors,
    };
  }

  private async closeDay(
    device: SimDevice,
    body: { fiscalDayNo: number; fiscalDayCounters: FiscalDayCounter[]; fiscalDayDeviceSignature: { hash: string; signature: string }; receiptCounter: number },
    publicKey: CryptoKey,
    operationID: string,
  ) {
    if (device.status !== "FiscalDayOpened") {
      throw new HttpError(422, "FDC02", "Fiscal day is not opened");
    }
    const day = device.days[device.days.length - 1]!;
    if (body.fiscalDayNo !== day.fiscalDayNo) {
      throw new HttpError(422, "FDC04", `Fiscal day number ${body.fiscalDayNo} is not the open day ${day.fiscalDayNo}`);
    }

    // Close is asynchronous: accepted now, settled after a delay, as observed.
    device.status = "FiscalDayCloseInitiated";
    device.closingErrorCode = undefined;

    const fiscalDayDate = day.opened.slice(0, 10);
    const canonical = fiscalDaySigningString(device.deviceId, day.fiscalDayNo, fiscalDayDate, day.counters);
    let verified = body.fiscalDayDeviceSignature?.hash === sha256Base64(canonical);
    if (verified) {
      try {
        verified = await webcrypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          publicKey,
          new Uint8Array(derToP1363(fromBase64(body.fiscalDayDeviceSignature.signature))),
          new Uint8Array(utf8Bytes(canonical)),
        );
      } catch {
        verified = false;
      }
    }
    const hasRed = day.receipts.some((r) => r.validationErrors.some((e) => e.validationErrorColor === RED));
    const countersMatch = body.receiptCounter === day.receipts.length;

    setTimeout(() => {
      if (!verified) {
        device.status = "FiscalDayOpened";
        device.closingErrorCode = "BadCertificateSignature";
      } else if (hasRed) {
        device.status = "FiscalDayOpened";
        device.closingErrorCode = "ReceiptsWithValidationErrors";
      } else if (!countersMatch) {
        device.status = "FiscalDayOpened";
        device.closingErrorCode = "CountersMismatch";
      } else {
        device.status = "FiscalDayClosed";
        day.closed = fdmsDateTime(new Date());
      }
    }, this.options.closeDelayMs).unref();

    return { operationID };
  }
}

function summarise(receipts: Receipt[]) {
  const map = new Map<string, { receiptType: string; receiptCurrency: string; receiptQuantity: number; receiptTotalAmount: number }>();
  for (const r of receipts) {
    const k = `${r.receiptType}|${r.receiptCurrency}`;
    const e = map.get(k) ?? { receiptType: r.receiptType, receiptCurrency: r.receiptCurrency, receiptQuantity: 0, receiptTotalAmount: 0 };
    e.receiptQuantity += 1;
    e.receiptTotalAmount = (toCents(e.receiptTotalAmount) + toCents(r.receiptTotal)) / 100;
    map.set(k, e);
  }
  return [...map.values()];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export { p1363ToDer };
