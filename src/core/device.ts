import { FdmsClient, type FdmsClientOptions, type Transport } from "./transport.js";
import { type Signer, type EcdsaSignatureFormat, signCanonicalString } from "./signer.js";
import { ServerCorrectedClock, type Clock } from "./clock.js";
import { buildCsr, deviceCommonName } from "./csr.js";
import { receiptQrData } from "./qr.js";
import { amountToCents, centsToAmount, type Money } from "./money.js";
import type { Storage } from "./storage.js";
import {
  compareReceiptTaxes,
  fdmsDate,
  fdmsDateTime,
  fiscalDaySigningString,
  formatTaxPercent,
  receiptSigningString,
  toCents,
} from "./signing.js";
import {
  FdmsApiError,
  type CloseDayRequest,
  type CloseDayResponse,
  type CreditDebitNote,
  type DeviceIdentity,
  type FiscalDayCounter,
  type GetConfigResponse,
  type GetStatusResponse,
  type MoneyType,
  type OpenDayResponse,
  type PingResponse,
  type Receipt,
  type ReceiptLine,
  type ReceiptTax,
  type ReceiptType,
  type SubmitReceiptResponse,
} from "./types.js";

export interface ReceiptLineInput {
  name: string;
  /**
   * Unit price, tax-inclusive if linesTaxInclusive. A whole number of major
   * units or `cents("11.50")`; a fractional number throws. See money.ts.
   */
  price: number | Money;
  quantity: number;
  taxId: number;
  /** Percent for taxed lines; null/undefined for exempt lines. */
  taxPercent?: number | null;
  taxCode?: string;
  hsCode?: string;
}

export interface ReceiptInput {
  receiptType?: ReceiptType;
  currency: string;
  invoiceNo: string;
  lines: ReceiptLineInput[];
  payments: { moneyType: MoneyType; amount: number | Money }[];
  linesTaxInclusive?: boolean;
  receiptDate?: Date;
  notes?: string;
  buyer?: Receipt["buyerData"];
  /** Required for CreditNote/DebitNote: reference to the original receipt. */
  creditDebitNote?: Receipt["creditDebitNote"];
}

export interface FiscalDayState {
  fiscalDayNo: number;
  fiscalDayDate: string;
  receiptCounter: number;
  receiptGlobalNo: number;
  previousReceiptHash?: string;
  /** fdmsDateTime of the last submitted receipt — FDMS requires strictly increasing receiptDates (RCPT030). */
  previousReceiptDate?: string;
  counters: FiscalDayCounter[];
  /**
   * Receipts FDMS accepted with a Red validation error. A day carrying one
   * can no longer be closed by the device (CloseDay fails with
   * ReceiptsWithValidationErrors); only ZIMRA can close it.
   */
  redErrors?: RedValidationError[];
}

export interface RedValidationError {
  receiptGlobalNo: number;
  receiptCounter: number;
  code: string;
  description?: string;
}

/**
 * A receipt that has been numbered, hash-chained and signed but not yet
 * accepted by FDMS. Plain JSON, so it can sit in a journal or a pending
 * marker across a restart.
 */
export interface PreparedReceipt {
  receipt: Receipt;
  /** ISO timestamp of the receiptDate, for the QR code after a restart. */
  date: string;
  /** Day state once this receipt is committed, minus any Red errors FDMS reports. */
  stateAfter: FiscalDayState;
}

/** Thrown by closeDay() when the day holds Red validation errors. */
export class DayNotClosableError extends Error {
  constructor(
    public readonly fiscalDayNo: number,
    public readonly redErrors: RedValidationError[],
  ) {
    super(
      `Fiscal day ${fiscalDayNo} has ${redErrors.length} receipt(s) with Red validation errors (` +
        redErrors.map((e) => `global no ${e.receiptGlobalNo}: ${e.code}`).join(", ") +
        `). FDMS will reject a device CloseDay with ReceiptsWithValidationErrors; the day must be closed by ZIMRA.`,
    );
    this.name = "DayNotClosableError";
  }
}

/**
 * Thrown when a receipt is submitted or a day closed while a previous
 * submit is still unresolved: the marker was written, the process died or
 * the network dropped before FDMS answered. Call reconcile() first.
 */
export class PendingSubmitError extends Error {
  constructor(public readonly receiptGlobalNo: number) {
    super(
      `Receipt global no ${receiptGlobalNo} was submitted but its outcome is unknown. Call reconcile() before issuing another receipt.`,
    );
    this.name = "PendingSubmitError";
  }
}

/**
 * Thrown by signReceipt() and submitReceipt() when a ReceiptInput cannot
 * make a valid receipt. Raised before anything is numbered, signed or sent,
 * so the day state is unchanged. `field` is a path into the input, such as
 * "lines[2].quantity".
 */
export class ReceiptValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = "ReceiptValidationError";
  }
}

export type ReconcileResult =
  | { action: "none" }
  /** FDMS already had the receipt; local state caught up. */
  | { action: "confirmed"; receiptGlobalNo: number }
  /** FDMS did not have it; the same signed receipt was sent again and accepted. */
  | { action: "resubmitted"; receiptGlobalNo: number; response: SubmitReceiptResponse }
  /** FDMS refused the resubmit. Counters were not advanced; the receipt is dropped. */
  | { action: "rejected"; receiptGlobalNo: number; error: FdmsApiError };

export interface SubmittedReceipt {
  receipt: Receipt;
  response: SubmitReceiptResponse;
  /** Data string to encode into the printed QR code. */
  qrData?: string;
}

/** Everything a platform has to supply. See the Signer and Transport docs. */
export interface FiscalDeviceDeps {
  signer: Signer;
  transport: Transport;
  /**
   * Source of receipt and fiscal-day dates. Wrapped in a ServerCorrectedClock
   * unless it already is one, so dates track FDMS rather than the device.
   */
  clock?: Clock;
  /**
   * Where day state and the pending-submit marker live. Without it the
   * device is in-memory only and the caller owns getState()/restoreState().
   */
  storage?: Storage;
}

export interface FiscalDeviceOptions extends FdmsClientOptions {
  signatureFormat?: EcdsaSignatureFormat;
}

const KEY_DAY_STATE = "day-state";
const KEY_PENDING = "pending-submit";
const KEY_LAST_GLOBAL = "last-receipt-global-no";

/**
 * High-level fiscal device client. Owns the stateful parts of FDMS everyone
 * gets wrong: receipt counters, the receipt hash chain, fiscal-day counter
 * accumulation and day-close signing.
 *
 * With a Storage, state is persisted before every FDMS call and a restart
 * picks up exactly where it stopped via reconcile(). Without one, persist
 * `getState()` after every receipt and pass it back via `restoreState()`.
 */
export class FiscalDevice {
  protected readonly http: FdmsClient;
  protected readonly signer: Signer;
  protected readonly storage?: Storage;
  /** Server-corrected clock; `offsetMs` and `confidence` are readable. */
  readonly clock: ServerCorrectedClock;
  private state?: FiscalDayState;
  private config?: GetConfigResponse;

  constructor(
    protected readonly device: DeviceIdentity,
    deps: FiscalDeviceDeps,
    private readonly options: FiscalDeviceOptions = {},
  ) {
    this.signer = deps.signer;
    this.storage = deps.storage;
    this.clock =
      deps.clock instanceof ServerCorrectedClock ? deps.clock : new ServerCorrectedClock(deps.clock);
    this.http = new FdmsClient(device, deps.transport, {
      ...options,
      onServerDate: (d, rtt) => {
        this.clock.learn(d, rtt);
        options.onServerDate?.(d, rtt);
      },
    });
  }

  private get signatureFormat(): EcdsaSignatureFormat {
    return this.options.signatureFormat ?? "der";
  }

  // -- state ---------------------------------------------------------------

  getState(): FiscalDayState | undefined {
    return this.state ? cloneState(this.state) : undefined;
  }

  restoreState(state: FiscalDayState): void {
    this.state = cloneState(state);
  }

  /** Highest receipt global number this device has issued, from storage. */
  async lastIssuedGlobalNo(): Promise<number | undefined> {
    const raw = await this.storage?.get(KEY_LAST_GLOBAL);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { deviceId: number; lastReceiptGlobalNo: number };
    return v.deviceId === this.device.deviceId ? v.lastReceiptGlobalNo : undefined;
  }

  private async persistState(): Promise<void> {
    if (!this.storage) return;
    if (this.state) {
      await this.storage.set(
        KEY_DAY_STATE,
        JSON.stringify({ deviceId: this.device.deviceId, savedAt: new Date().toISOString(), state: this.state }),
      );
      const prev = (await this.lastIssuedGlobalNo()) ?? 0;
      if (this.state.receiptGlobalNo > prev) {
        await this.storage.set(
          KEY_LAST_GLOBAL,
          JSON.stringify({ deviceId: this.device.deviceId, lastReceiptGlobalNo: this.state.receiptGlobalNo }),
        );
      }
    }
  }

  private async loadPersistedState(): Promise<void> {
    if (this.state || !this.storage) return;
    const raw = await this.storage.get(KEY_DAY_STATE);
    if (!raw) return;
    const p = JSON.parse(raw) as { deviceId: number; state: FiscalDayState };
    if (p.deviceId !== this.device.deviceId) {
      throw new Error(
        `Stored day state belongs to device ${p.deviceId}, not ${this.device.deviceId}`,
      );
    }
    this.state = p.state;
  }

  /** The receipt whose submit is unresolved, if any. */
  async pendingReceipt(): Promise<PreparedReceipt | undefined> {
    const raw = await this.storage?.get(KEY_PENDING);
    return raw ? (JSON.parse(raw) as PreparedReceipt) : undefined;
  }

  /**
   * Bring a restarted device back to a known state. Loads persisted day
   * state, then settles any pending submit by asking FDMS whether it
   * arrived and resubmitting the identical signed receipt if not. Call it
   * on startup before the first receipt; submitReceipt() and closeDay()
   * refuse to run while a submit is pending.
   *
   * Confirmation uses GetStatus.lastReceiptGlobalNo, which is the number of
   * the receipt with the latest date rather than the highest issued, so
   * after a future-dated receipt (RCPT031) it can under-report and the
   * resubmit path is taken instead; FDMS then answers with a Red RCPT012
   * for the duplicate number.
   */
  async reconcile(): Promise<ReconcileResult> {
    await this.loadPersistedState();
    const pending = await this.pendingReceipt();
    if (!pending) return { action: "none" };
    const receiptGlobalNo = pending.receipt.receiptGlobalNo;

    const status = await this.getStatus();
    if ((status.lastReceiptGlobalNo ?? 0) >= receiptGlobalNo) {
      await this.commitPrepared(pending, undefined);
      return { action: "confirmed", receiptGlobalNo };
    }
    try {
      const response = await this.http.request<SubmitReceiptResponse>(
        "POST",
        this.http.devicePath("SubmitReceipt"),
        { receipt: pending.receipt },
      );
      await this.commitPrepared(pending, response);
      return { action: "resubmitted", receiptGlobalNo, response };
    } catch (error) {
      if (error instanceof FdmsApiError) {
        await this.storage?.delete(KEY_PENDING);
        return { action: "rejected", receiptGlobalNo, error };
      }
      throw error;
    }
  }

  /**
   * Forget the pending marker without asking FDMS. Only for a caller that
   * has taken ownership of the receipt itself, such as the offline queue
   * moving a receipt into its journal after a network failure.
   */
  async discardPending(): Promise<void> {
    await this.storage?.delete(KEY_PENDING);
  }

  // -- basic endpoints -----------------------------------------------------

  async getConfig(): Promise<GetConfigResponse> {
    this.config = await this.http.request<GetConfigResponse>(
      "GET",
      this.http.devicePath("GetConfig"),
    );
    return this.config;
  }

  async getStatus(): Promise<GetStatusResponse> {
    return this.http.request<GetStatusResponse>(
      "GET",
      this.http.devicePath("GetStatus"),
    );
  }

  async ping(): Promise<PingResponse> {
    return this.http.request<PingResponse>(
      "POST",
      this.http.devicePath("Ping"),
    );
  }

  /**
   * Renew the device certificate before expiry (GetConfig's
   * certificateValidTill tells you when). The CSR is signed by `signer`,
   * which defaults to the device's own key, so a hardware key keeps the same
   * key pair across renewals. Persist the returned certificate and reconnect.
   */
  async renewCertificate(signer: Signer = this.signer): Promise<{
    csrPem: string;
    certificatePem: string;
    operationId: string;
  }> {
    const csrPem = await buildCsr(
      signer,
      deviceCommonName(this.device.serialNumber, this.device.deviceId),
    );
    const res = await this.http.request<{
      operationID: string;
      certificate: string;
    }>("POST", this.http.devicePath("IssueCertificate"), {
      certificateRequest: csrPem,
    });
    return { csrPem, certificatePem: res.certificate, operationId: res.operationID };
  }

  // -- fiscal day ----------------------------------------------------------

  /**
   * Open a fiscal day. Receipt global numbers continue from the largest of
   * the server's `lastReceiptGlobalNo`, the highest number in storage, and
   * `opts.lastReceiptGlobalNo`. FDMS reports the number of the receipt with
   * the latest receiptDate, not the highest issued, so after a future-dated
   * receipt it under-reports and the local record wins.
   */
  async openDay(
    fiscalDayNo?: number,
    opened?: Date,
    opts: { lastReceiptGlobalNo?: number } = {},
  ): Promise<OpenDayResponse> {
    await this.refusePending();
    const status = await this.getStatus();
    // GetStatus has just taught the clock the server offset, so an
    // unspecified open time is server time, not device time.
    opened ??= this.clock.now();
    if (status.fiscalDayStatus !== "FiscalDayClosed") {
      throw new Error(
        `Cannot open a fiscal day while status is ${status.fiscalDayStatus}`,
      );
    }
    const res = await this.http.request<OpenDayResponse>(
      "POST",
      this.http.devicePath("OpenDay"),
      {
        fiscalDayNo: fiscalDayNo ?? null,
        fiscalDayOpened: fdmsDateTime(opened),
      },
    );
    const lastGlobal = Math.max(
      status.lastReceiptGlobalNo ?? 0,
      opts.lastReceiptGlobalNo ?? 0,
      (await this.lastIssuedGlobalNo()) ?? 0,
    );
    this.state = {
      fiscalDayNo: res.fiscalDayNo,
      fiscalDayDate: fdmsDate(opened),
      receiptCounter: 0,
      receiptGlobalNo: lastGlobal,
      previousReceiptHash: undefined,
      counters: [],
    };
    await this.persistState();
    return res;
  }

  /**
   * Sign and submit CloseDay. Refuses up front when the day holds Red
   * validation errors, since FDMS will fail the close anyway; pass
   * `{ force: true }` to submit regardless. Local state is cleared once
   * FDMS accepts the request; the close itself completes asynchronously
   * (poll getStatus() for FiscalDayClosed).
   */
  async closeDay(opts: { force?: boolean } = {}): Promise<CloseDayResponse> {
    await this.refusePending();
    const s = this.requireDay();
    if (!opts.force && s.redErrors?.length) {
      throw new DayNotClosableError(s.fiscalDayNo, s.redErrors);
    }
    // A day persisted by an earlier SDK version can hold "usd" and "USD"
    // counter sets. Merge them so CloseDay signs and sends one set.
    const counters = mergeCurrencyCase(s.counters);
    const canonical = fiscalDaySigningString(
      this.device.deviceId,
      s.fiscalDayNo,
      s.fiscalDayDate,
      counters,
    );
    const signature = await signCanonicalString(
      this.signer,
      canonical,
      this.signatureFormat,
    );
    const body: CloseDayRequest = {
      fiscalDayNo: s.fiscalDayNo,
      fiscalDayCounters: counters.filter(
        (c) => toCents(c.fiscalCounterValue) !== 0,
      ),
      fiscalDayDeviceSignature: signature,
      receiptCounter: s.receiptCounter,
    };
    const res = await this.http.request<CloseDayResponse>(
      "POST",
      this.http.devicePath("CloseDay"),
      body,
    );
    // In-memory state is dropped, but the stored copy stays until
    // clearPersistedState(): CloseDay completes asynchronously and a
    // rejected close needs the counters and date for a retry.
    this.state = undefined;
    return res;
  }

  /** Delete the stored day state. Call once GetStatus reports FiscalDayClosed. */
  async clearPersistedState(): Promise<void> {
    this.state = undefined;
    await this.storage?.delete(KEY_DAY_STATE);
  }

  // -- receipts ------------------------------------------------------------

  /**
   * Number, hash-chain and sign a receipt against the current state without
   * submitting it or advancing counters. The offline queue uses this to fix
   * the chain at sale time; submitReceipt() uses it and submits in one step.
   */
  async signReceipt(input: ReceiptInput): Promise<PreparedReceipt> {
    const s = this.requireDay();
    validateReceiptInput(input, s.previousReceiptDate);
    const receiptType = input.receiptType ?? "FiscalInvoice";
    const inclusive = input.linesTaxInclusive ?? true;
    let date = input.receiptDate ?? this.clock.now();
    // FDMS rejects a receiptDate that is not strictly greater than the previous
    // receipt's (RCPT030, Red), and the format only resolves to whole seconds —
    // so back-to-back receipts in the same second must be nudged forward.
    // Only auto-generated dates are nudged; an explicit receiptDate is trusted.
    if (
      input.receiptDate === undefined &&
      s.previousReceiptDate &&
      fdmsDateTime(date) <= s.previousReceiptDate
    ) {
      date = new Date(new Date(s.previousReceiptDate).getTime() + 1000);
    }

    const lines: ReceiptLine[] = input.lines.map((l, i) => {
      const priceCents = amountToCents(l.price, `lines[${i}].price`);
      return {
        receiptLineType: "Sale",
        receiptLineNo: i + 1,
        receiptLineHSCode: l.hsCode ?? null,
        receiptLineName: l.name,
        receiptLinePrice: centsToAmount(priceCents),
        receiptLineQuantity: l.quantity,
        receiptLineTotal: centsToAmount(Math.round(priceCents * l.quantity)),
        taxCode: l.taxCode ?? null,
        taxPercent: l.taxPercent ?? null,
        taxID: l.taxId,
      };
    });

    const taxes = buildReceiptTaxes(lines, inclusive);
    const receiptTotalCents =
      lines.reduce((sum, l) => sum + toCents(l.receiptLineTotal), 0) +
      (inclusive ? 0 : taxes.reduce((sum, t) => sum + toCents(t.taxAmount), 0));
    const receiptTotal = centsToAmount(receiptTotalCents);

    const paymentsTotalCents = input.payments.reduce(
      (sum, p, i) => sum + amountToCents(p.amount, `payments[${i}].amount`),
      0,
    );
    if (paymentsTotalCents !== receiptTotalCents) {
      throw new ReceiptValidationError(
        "payments",
        `Payments (${centsToAmount(paymentsTotalCents)}) do not equal receipt total (${receiptTotal})`,
      );
    }

    const unsigned: Omit<Receipt, "receiptDeviceSignature"> = {
      receiptType,
      // The signing string uppercases the currency, so the stored receipt and
      // the day counters must too, or "usd" and "USD" split one day's totals.
      receiptCurrency: input.currency.toUpperCase(),
      receiptCounter: s.receiptCounter + 1,
      receiptGlobalNo: s.receiptGlobalNo + 1,
      invoiceNo: input.invoiceNo,
      buyerData: input.buyer ?? null,
      receiptNotes: input.notes ?? null,
      receiptDate: fdmsDateTime(date),
      creditDebitNote: input.creditDebitNote ?? null,
      receiptLinesTaxInclusive: inclusive,
      receiptLines: lines,
      receiptTaxes: taxes,
      receiptPayments: input.payments.map((p, i) => ({
        moneyTypeCode: p.moneyType,
        paymentAmount: centsToAmount(amountToCents(p.amount, `payments[${i}].amount`)),
      })),
      receiptTotal,
      receiptPrintForm: "Receipt48",
    };

    const canonical = receiptSigningString(
      this.device.deviceId,
      unsigned,
      s.previousReceiptHash,
    );
    const signature = await signCanonicalString(
      this.signer,
      canonical,
      this.signatureFormat,
    );
    const receipt: Receipt = { ...unsigned, receiptDeviceSignature: signature };

    const stateAfter = cloneState(s);
    stateAfter.receiptCounter += 1;
    stateAfter.receiptGlobalNo += 1;
    stateAfter.previousReceiptHash = signature.hash;
    stateAfter.previousReceiptDate = fdmsDateTime(date);
    accumulateCounters(stateAfter.counters, receipt);

    return { receipt, date: date.toISOString(), stateAfter };
  }

  /**
   * Advance local state past a signed receipt that has not been submitted,
   * so the next receipt chains after it. The offline queue calls this when
   * it takes a receipt into its journal.
   */
  async applyPrepared(prepared: PreparedReceipt): Promise<void> {
    const s = this.requireDay();
    if (prepared.receipt.receiptGlobalNo !== s.receiptGlobalNo + 1) {
      throw new Error(
        `Receipt global no ${prepared.receipt.receiptGlobalNo} does not follow ${s.receiptGlobalNo}`,
      );
    }
    this.state = cloneState(prepared.stateAfter);
    await this.persistState();
  }

  /**
   * Submit a signed receipt. The pending marker is written before the
   * request, so a crash or dropped connection at any point leaves enough on
   * disk for reconcile() to finish the job without a duplicate or a gap.
   */
  async submitPrepared(prepared: PreparedReceipt): Promise<SubmittedReceipt> {
    await this.refusePending();
    await this.storage?.set(KEY_PENDING, JSON.stringify(prepared));

    let response: SubmitReceiptResponse;
    try {
      response = await this.http.request<SubmitReceiptResponse>(
        "POST",
        this.http.devicePath("SubmitReceipt"),
        { receipt: prepared.receipt },
      );
    } catch (err) {
      // A server answer means FDMS did not take the receipt; nothing is
      // pending. A network failure keeps the marker for reconcile().
      if (err instanceof FdmsApiError) await this.storage?.delete(KEY_PENDING);
      throw err;
    }

    await this.commitPrepared(prepared, response);
    return {
      receipt: prepared.receipt,
      response,
      qrData: this.qrData(prepared),
    };
  }

  /**
   * Build, sign and submit a receipt. Counters, global numbers, tax summary,
   * hash chain and QR data are all computed here.
   */
  async submitReceipt(input: ReceiptInput): Promise<SubmittedReceipt> {
    await this.refusePending();
    return this.submitPrepared(await this.signReceipt(input));
  }

  /** QR data for a receipt, when getConfig() has supplied the qrUrl. */
  qrData(prepared: PreparedReceipt): string | undefined {
    if (!this.config) return undefined;
    return receiptQrData({
      qrUrl: this.config.qrUrl,
      deviceId: this.device.deviceId,
      receiptDate: new Date(prepared.date),
      receiptGlobalNo: prepared.receipt.receiptGlobalNo,
      deviceSignatureBase64: prepared.receipt.receiptDeviceSignature.signature,
    });
  }

  private async commitPrepared(
    prepared: PreparedReceipt,
    response: SubmitReceiptResponse | undefined,
  ): Promise<void> {
    // The queue path has already applied stateAfter; the direct path has not.
    if (!this.state || this.state.receiptGlobalNo < prepared.receipt.receiptGlobalNo) {
      this.state = cloneState(prepared.stateAfter);
    }
    for (const v of response?.validationErrors ?? []) {
      if (v.validationErrorColor?.toLowerCase() === "red") {
        (this.state.redErrors ??= []).push({
          receiptGlobalNo: prepared.receipt.receiptGlobalNo,
          receiptCounter: prepared.receipt.receiptCounter,
          code: v.validationErrorCode ?? "?",
          description: v.validationErrorDescription,
        });
      }
    }
    await this.persistState();
    await this.storage?.delete(KEY_PENDING);
  }

  private async refusePending(): Promise<void> {
    const pending = await this.pendingReceipt();
    if (pending) throw new PendingSubmitError(pending.receipt.receiptGlobalNo);
  }

  private requireDay(): FiscalDayState {
    if (!this.state) {
      throw new Error(
        "No fiscal day state. Call openDay(), reconcile() with a Storage, or restoreState() with persisted state.",
      );
    }
    return this.state;
  }
}

// ---------------------------------------------------------------------------

const RECEIPT_TYPES: readonly ReceiptType[] = ["FiscalInvoice", "CreditNote", "DebitNote"];

/**
 * Refuse inputs FDMS would reject or record wrongly, naming the field.
 * Amounts are checked here too so every input error is a
 * ReceiptValidationError. Payments adding up is checked in signReceipt,
 * once the total is known.
 */
function validateReceiptInput(input: ReceiptInput, previousReceiptDate?: string): void {
  const fail = (field: string, reason: string): never => {
    throw new ReceiptValidationError(field, reason);
  };
  const amount = (v: number | Money, field: string): void => {
    let c: number;
    try {
      c = amountToCents(v, field);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(field, msg.startsWith(`${field}: `) ? msg.slice(field.length + 2) : msg);
    }
    if (!Number.isSafeInteger(c)) fail(field, `${String(v)} is too large to hold exactly in cents`);
  };

  if (input.receiptType !== undefined && !RECEIPT_TYPES.includes(input.receiptType)) {
    fail("receiptType", `expected one of ${RECEIPT_TYPES.join(", ")}, got ${String(input.receiptType)}`);
  }
  if (typeof input.currency !== "string" || !/^[A-Za-z]{3}$/.test(input.currency)) {
    fail("currency", `expected a three-letter ISO 4217 code, got ${JSON.stringify(input.currency)}`);
  }
  if (typeof input.invoiceNo !== "string" || input.invoiceNo.trim() === "") {
    fail("invoiceNo", "must be a non-empty string");
  }
  if (input.invoiceNo.length > 50) {
    fail("invoiceNo", `is ${input.invoiceNo.length} characters; FDMS allows at most 50`);
  }
  if (input.receiptType === "CreditNote" || input.receiptType === "DebitNote") {
    validateCreditDebitNote(input.creditDebitNote, input.receiptType, fail);
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fail("lines", "a receipt needs at least one line");
  }
  if (!Array.isArray(input.payments) || input.payments.length === 0) {
    fail("payments", "a receipt needs at least one payment");
  }

  input.lines.forEach((l, i) => {
    const at = `lines[${i}]`;
    if (l === null || typeof l !== "object") fail(at, "must be an object");
    if (typeof l.name !== "string" || l.name.trim() === "") fail(`${at}.name`, "must be a non-empty string");
    amount(l.price, `${at}.price`);
    if (typeof l.quantity !== "number" || !Number.isFinite(l.quantity) || l.quantity <= 0) {
      fail(`${at}.quantity`, `must be a finite number greater than 0, got ${String(l.quantity)}`);
    }
    if (!Number.isInteger(l.taxId)) fail(`${at}.taxId`, `must be an integer, got ${String(l.taxId)}`);
    if (
      l.taxPercent !== undefined &&
      l.taxPercent !== null &&
      (typeof l.taxPercent !== "number" || !Number.isFinite(l.taxPercent) || l.taxPercent < 0)
    ) {
      fail(`${at}.taxPercent`, `must be a finite number of at least 0, or null for exempt, got ${String(l.taxPercent)}`);
    }
  });
  input.payments.forEach((p, i) => {
    if (p === null || typeof p !== "object") fail(`payments[${i}]`, "must be an object");
    amount(p.amount, `payments[${i}].amount`);
  });

  // Only an explicit date is checked: generated dates are nudged forward in
  // signReceipt. A date at or before the previous receipt's gets RCPT030
  // (Red), after which the device can no longer close the day.
  if (input.receiptDate !== undefined) {
    if (!(input.receiptDate instanceof Date) || Number.isNaN(input.receiptDate.getTime())) {
      fail("receiptDate", "must be a valid Date");
    }
    const date = fdmsDateTime(input.receiptDate);
    if (previousReceiptDate && date <= previousReceiptDate) {
      fail(
        "receiptDate",
        `${date} is not after the previous receipt's ${previousReceiptDate}; FDMS would answer RCPT030 and the day could no longer be closed by the device`,
      );
    }
  }
}

/**
 * A credit or debit note must say which receipt it corrects: either the
 * FDMS receiptID, or the original's deviceID, receiptGlobalNo and
 * fiscalDayNo together. Without one FDMS cannot link the note to a sale.
 */
function validateCreditDebitNote(
  ref: ReceiptInput["creditDebitNote"],
  receiptType: ReceiptType,
  fail: (field: string, reason: string) => never,
): void {
  const field = "creditDebitNote";
  if (ref === undefined || ref === null) {
    fail(field, `is required for a ${receiptType}: reference the original receipt by receiptID, or by deviceID, receiptGlobalNo and fiscalDayNo`);
  }
  if (typeof ref !== "object" || Array.isArray(ref)) fail(field, "must be an object");
  const given = (v: unknown): boolean => v !== undefined && v !== null;
  const positiveInt = (key: keyof CreditDebitNote): void => {
    const v = ref[key];
    if (!Number.isSafeInteger(v) || (v as number) <= 0) {
      fail(`${field}.${key}`, `must be a positive integer, got ${String(v)}`);
    }
  };
  // Every part that is given is sent to FDMS, so check each one.
  const byNumber = ["deviceID", "receiptGlobalNo", "fiscalDayNo"] as const;
  for (const k of ["receiptID", ...byNumber] as const) {
    if (given(ref[k])) positiveInt(k);
  }
  if (given(ref.receiptID)) return;
  if (!byNumber.some((k) => given(ref[k]))) {
    fail(field, "has no reference: give receiptID, or deviceID, receiptGlobalNo and fiscalDayNo");
  }
  for (const k of byNumber) {
    if (!given(ref[k])) fail(`${field}.${k}`, "is required when receiptID is not given");
  }
}

/** State is plain JSON; structuredClone is missing on Hermes. */
function cloneState(state: FiscalDayState): FiscalDayState {
  return JSON.parse(JSON.stringify(state)) as FiscalDayState;
}

/**
 * Group lines by tax and compute the receipt tax summary. Arithmetic is in
 * integer cents; each line's tax is rounded on its own, as FDMS does.
 * taxCode is part of the group, so two codes under one taxID stay separate
 * entries, as in the spec's own example.
 */
export function buildReceiptTaxes(
  lines: ReceiptLine[],
  taxInclusive: boolean,
): ReceiptTax[] {
  const groups = new Map<string, { tax: ReceiptTax; taxCents: number; salesCents: number }>();
  for (const line of lines) {
    const key = `${line.taxID}|${line.taxPercent ?? ""}|${line.taxCode ?? ""}`;
    const g = groups.get(key) ?? {
      tax: {
        taxCode: line.taxCode ?? null,
        taxPercent: line.taxPercent ?? null,
        taxID: line.taxID,
        taxAmount: 0,
        salesAmountWithTax: 0,
      },
      taxCents: 0,
      salesCents: 0,
    };
    const totalCents = toCents(line.receiptLineTotal);
    const taxCents = lineTaxCents(totalCents, line.taxPercent ?? 0, taxInclusive);
    g.taxCents += taxCents;
    g.salesCents += taxInclusive ? totalCents : totalCents + taxCents;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g.tax,
      taxAmount: centsToAmount(g.taxCents),
      salesAmountWithTax: centsToAmount(g.salesCents),
    }))
    .sort(compareReceiptTaxes);
}

/**
 * Tax on one line total, in integer cents, rounded half away from zero.
 *
 * The rate is taken in hundredths of a percent from the same two-decimal
 * text that is signed (formatTaxPercent), so the tax always matches the
 * signed percent. All arithmetic is on integers: a float multiply such as
 * 100 * 0.145 gives 14.499999999999998 and rounds to 14 instead of 15.
 *
 *   exclusive: tax = total * bp / 10000
 *   inclusive: tax = total * bp / (10000 + bp)
 */
function lineTaxCents(totalCents: number, taxPercent: number, taxInclusive: boolean): number {
  const bp = Number(formatTaxPercent(taxPercent).replace(".", ""));
  if (!Number.isSafeInteger(bp)) {
    throw new RangeError(`taxPercent ${taxPercent} is not a finite percentage`);
  }
  const numerator = totalCents * bp;
  if (!Number.isSafeInteger(numerator)) {
    throw new RangeError(
      `tax on a line total of ${totalCents} cents at ${taxPercent}% is too large to compute exactly`,
    );
  }
  const denominator = taxInclusive ? 10000 + bp : 10000;
  if (denominator <= 0) {
    throw new RangeError(`taxPercent ${taxPercent} is not a valid tax-inclusive rate`);
  }
  return divideRoundHalfAwayFromZero(numerator, denominator);
}

/** n / d for integers with d > 0, rounded half away from zero, exactly. */
function divideRoundHalfAwayFromZero(n: number, d: number): number {
  const abs = Math.abs(n);
  const rem = abs % d;
  let q = (abs - rem) / d;
  if (rem * 2 >= d) q += 1;
  return n < 0 ? 0 - q : q; // 0 - q, not -q: never -0
}

/**
 * Copy of the counters with each currency uppercased and counters that then
 * share type, currency, taxID and moneyType summed into one.
 */
function mergeCurrencyCase(counters: FiscalDayCounter[]): FiscalDayCounter[] {
  const merged: FiscalDayCounter[] = [];
  for (const c of counters) {
    const currency = c.fiscalCounterCurrency.toUpperCase();
    const same = merged.find(
      (m) =>
        m.fiscalCounterType === c.fiscalCounterType &&
        m.fiscalCounterCurrency === currency &&
        (m.fiscalCounterTaxID ?? null) === (c.fiscalCounterTaxID ?? null) &&
        (m.fiscalCounterMoneyType ?? null) === (c.fiscalCounterMoneyType ?? null),
    );
    if (same) {
      same.fiscalCounterValue = centsToAmount(
        toCents(same.fiscalCounterValue) + toCents(c.fiscalCounterValue),
      );
    } else {
      merged.push({ ...c, fiscalCounterCurrency: currency });
    }
  }
  return merged;
}

/** Fold a submitted receipt into the running fiscal-day counters. */
export function accumulateCounters(
  counters: FiscalDayCounter[],
  receipt: Receipt,
): void {
  const currency = receipt.receiptCurrency.toUpperCase();
  const sign = receipt.receiptType === "CreditNote" ? -1 : 1;
  const byTaxType =
    receipt.receiptType === "FiscalInvoice"
      ? ("SaleByTax" as const)
      : receipt.receiptType === "CreditNote"
        ? ("CreditNoteByTax" as const)
        : ("DebitNoteByTax" as const);
  const taxByTaxType =
    receipt.receiptType === "FiscalInvoice"
      ? ("SaleTaxByTax" as const)
      : receipt.receiptType === "CreditNote"
        ? ("CreditNoteTaxByTax" as const)
        : ("DebitNoteTaxByTax" as const);

  const upsert = (
    match: (c: FiscalDayCounter) => boolean,
    create: () => FiscalDayCounter,
    delta: number,
  ) => {
    const existing = counters.find(match);
    if (existing) {
      existing.fiscalCounterValue = centsToAmount(
        toCents(existing.fiscalCounterValue) + toCents(delta),
      );
    } else {
      const c = create();
      c.fiscalCounterValue = centsToAmount(toCents(delta));
      counters.push(c);
    }
  };

  for (const t of receipt.receiptTaxes) {
    upsert(
      (c) =>
        c.fiscalCounterType === byTaxType &&
        c.fiscalCounterCurrency.toUpperCase() === currency &&
        c.fiscalCounterTaxID === t.taxID,
      () => ({
        fiscalCounterType: byTaxType,
        fiscalCounterCurrency: currency,
        fiscalCounterTaxID: t.taxID,
        fiscalCounterTaxPercent: t.taxPercent ?? null,
        fiscalCounterValue: 0,
      }),
      sign * t.salesAmountWithTax,
    );
    upsert(
      (c) =>
        c.fiscalCounterType === taxByTaxType &&
        c.fiscalCounterCurrency.toUpperCase() === currency &&
        c.fiscalCounterTaxID === t.taxID,
      () => ({
        fiscalCounterType: taxByTaxType,
        fiscalCounterCurrency: currency,
        fiscalCounterTaxID: t.taxID,
        fiscalCounterTaxPercent: t.taxPercent ?? null,
        fiscalCounterValue: 0,
      }),
      sign * t.taxAmount,
    );
  }

  for (const p of receipt.receiptPayments) {
    upsert(
      (c) =>
        c.fiscalCounterType === "BalanceByMoneyType" &&
        c.fiscalCounterCurrency.toUpperCase() === currency &&
        c.fiscalCounterMoneyType === p.moneyTypeCode,
      () => ({
        fiscalCounterType: "BalanceByMoneyType",
        fiscalCounterCurrency: currency,
        fiscalCounterMoneyType: p.moneyTypeCode,
        fiscalCounterValue: 0,
      }),
      sign * p.paymentAmount,
    );
  }
}
