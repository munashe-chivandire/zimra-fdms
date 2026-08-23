import { FdmsHttpClient, type FdmsHttpOptions, type MtlsIdentity } from "./http.js";
import type { EcdsaSignatureFormat } from "./signing.js";
import { receiptQrData } from "./qr.js";
import {
  fdmsDate,
  fdmsDateTime,
  fiscalDaySigningString,
  receiptSigningString,
  signCanonicalString,
  toCents,
} from "./signing.js";
import type {
  CloseDayRequest,
  CloseDayResponse,
  DeviceIdentity,
  FiscalDayCounter,
  GetConfigResponse,
  GetStatusResponse,
  MoneyType,
  OpenDayResponse,
  PingResponse,
  Receipt,
  ReceiptLine,
  ReceiptTax,
  ReceiptType,
  SubmitReceiptResponse,
} from "./types.js";

export interface ReceiptLineInput {
  name: string;
  /** Unit price (tax-inclusive if linesTaxInclusive). */
  price: number;
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
  payments: { moneyType: MoneyType; amount: number }[];
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

export interface SubmittedReceipt {
  receipt: Receipt;
  response: SubmitReceiptResponse;
  /** Data string to encode into the printed QR code. */
  qrData?: string;
}

/**
 * High-level fiscal device client. Owns the stateful parts of FDMS everyone
 * gets wrong: receipt counters, the receipt hash chain, fiscal-day counter
 * accumulation and day-close signing.
 *
 * Persist `getState()` after every receipt and pass it back via
 * `restoreState()` on startup — the hash chain must survive restarts.
 */
export class FiscalDevice {
  private readonly http: FdmsHttpClient;
  private state?: FiscalDayState;
  private config?: GetConfigResponse;

  constructor(
    private readonly device: DeviceIdentity,
    private readonly identity: MtlsIdentity,
    private readonly options: FdmsHttpOptions & {
      signatureFormat?: EcdsaSignatureFormat;
    } = {},
  ) {
    this.http = new FdmsHttpClient(device, identity, options);
  }

  private get signatureFormat(): EcdsaSignatureFormat {
    return this.options.signatureFormat ?? "der";
  }

  // -- plumbing ------------------------------------------------------------

  getState(): FiscalDayState | undefined {
    return this.state ? structuredClone(this.state) : undefined;
  }

  restoreState(state: FiscalDayState): void {
    this.state = structuredClone(state);
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
   * certificateValidTill tells you when). Generates a fresh key pair + CSR;
   * persist the returned key and certificate and reconnect with them.
   */
  async renewCertificate(): Promise<{
    keys: import("./crypto.js").DeviceKeyPair;
    certificatePem: string;
    operationId: string;
  }> {
    const { generateDeviceCsr } = await import("./crypto.js");
    const keys = await generateDeviceCsr(
      this.device.serialNumber,
      this.device.deviceId,
    );
    const res = await this.http.request<{
      operationID: string;
      certificate: string;
    }>("POST", this.http.devicePath("IssueCertificate"), {
      certificateRequest: keys.csrPem,
    });
    return {
      keys,
      certificatePem: res.certificate,
      operationId: res.operationID,
    };
  }

  // -- fiscal day ----------------------------------------------------------

  /**
   * Open a fiscal day. Receipt global numbers continue from the server's
   * `lastReceiptGlobalNo`, but FDMS reports the number of the receipt with the
   * latest receiptDate, not the highest number issued, so after a
   * future-dated receipt it under-reports. Pass `opts.lastReceiptGlobalNo`
   * (the highest number this device has issued) and the larger wins.
   */
  async openDay(
    fiscalDayNo?: number,
    opened: Date = new Date(),
    opts: { lastReceiptGlobalNo?: number } = {},
  ): Promise<OpenDayResponse> {
    const status = await this.getStatus();
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
    const lastGlobal = Math.max(status.lastReceiptGlobalNo ?? 0, opts.lastReceiptGlobalNo ?? 0);
    this.state = {
      fiscalDayNo: res.fiscalDayNo,
      fiscalDayDate: fdmsDate(opened),
      receiptCounter: 0,
      receiptGlobalNo: lastGlobal,
      previousReceiptHash: undefined,
      counters: [],
    };
    return res;
  }

  /**
   * Sign and submit CloseDay. Refuses up front when the day holds Red
   * validation errors, since FDMS will fail the close anyway; pass
   * `{ force: true }` to submit regardless.
   */
  async closeDay(opts: { force?: boolean } = {}): Promise<CloseDayResponse> {
    const s = this.requireDay();
    if (!opts.force && s.redErrors?.length) {
      throw new DayNotClosableError(s.fiscalDayNo, s.redErrors);
    }
    const canonical = fiscalDaySigningString(
      this.device.deviceId,
      s.fiscalDayNo,
      s.fiscalDayDate,
      s.counters,
    );
    const signature = await signCanonicalString(
      this.identity.privateKeyPem,
      canonical,
      this.signatureFormat,
    );
    const body: CloseDayRequest = {
      fiscalDayNo: s.fiscalDayNo,
      fiscalDayCounters: s.counters.filter(
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
    this.state = undefined;
    return res;
  }

  // -- receipts ------------------------------------------------------------

  /**
   * Build, sign and submit a receipt. Counters, global numbers, tax summary,
   * hash chain and QR data are all computed here.
   */
  async submitReceipt(input: ReceiptInput): Promise<SubmittedReceipt> {
    const s = this.requireDay();
    const receiptType = input.receiptType ?? "FiscalInvoice";
    const inclusive = input.linesTaxInclusive ?? true;
    let date = input.receiptDate ?? new Date();
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

    const lines: ReceiptLine[] = input.lines.map((l, i) => ({
      receiptLineType: "Sale",
      receiptLineNo: i + 1,
      receiptLineHSCode: l.hsCode ?? null,
      receiptLineName: l.name,
      receiptLinePrice: l.price,
      receiptLineQuantity: l.quantity,
      receiptLineTotal: round2(l.price * l.quantity),
      taxCode: l.taxCode ?? null,
      taxPercent: l.taxPercent ?? null,
      taxID: l.taxId,
    }));

    const taxes = buildReceiptTaxes(lines, inclusive);
    const receiptTotal = round2(
      lines.reduce((sum, l) => sum + l.receiptLineTotal, 0) +
        (inclusive ? 0 : taxes.reduce((sum, t) => sum + t.taxAmount, 0)),
    );

    const paymentsTotal = round2(
      input.payments.reduce((sum, p) => sum + p.amount, 0),
    );
    if (toCents(paymentsTotal) !== toCents(receiptTotal)) {
      throw new Error(
        `Payments (${paymentsTotal}) do not equal receipt total (${receiptTotal})`,
      );
    }

    const unsigned: Omit<Receipt, "receiptDeviceSignature"> = {
      receiptType,
      receiptCurrency: input.currency,
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
      receiptPayments: input.payments.map((p) => ({
        moneyTypeCode: p.moneyType,
        paymentAmount: p.amount,
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
      this.identity.privateKeyPem,
      canonical,
      this.signatureFormat,
    );
    const receipt: Receipt = { ...unsigned, receiptDeviceSignature: signature };

    const response = await this.http.request<SubmitReceiptResponse>(
      "POST",
      this.http.devicePath("SubmitReceipt"),
      { receipt },
    );

    // Commit state only after the server accepted the receipt.
    s.receiptCounter += 1;
    s.receiptGlobalNo += 1;
    s.previousReceiptHash = signature.hash;
    s.previousReceiptDate = fdmsDateTime(date);
    accumulateCounters(s.counters, receipt);
    for (const v of response.validationErrors ?? []) {
      if (v.validationErrorColor?.toLowerCase() === "red") {
        (s.redErrors ??= []).push({
          receiptGlobalNo: receipt.receiptGlobalNo,
          receiptCounter: receipt.receiptCounter,
          code: v.validationErrorCode ?? "?",
          description: v.validationErrorDescription,
        });
      }
    }

    return {
      receipt,
      response,
      qrData: this.config
        ? receiptQrData({
            qrUrl: this.config.qrUrl,
            deviceId: this.device.deviceId,
            receiptDate: date,
            receiptGlobalNo: receipt.receiptGlobalNo,
            deviceSignatureBase64: signature.signature,
          })
        : undefined,
    };
  }

  private requireDay(): FiscalDayState {
    if (!this.state) {
      throw new Error(
        "No fiscal day state. Call openDay(), or restoreState() with persisted state.",
      );
    }
    return this.state;
  }
}

// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Group lines by tax and compute the receipt tax summary. */
export function buildReceiptTaxes(
  lines: ReceiptLine[],
  taxInclusive: boolean,
): ReceiptTax[] {
  const groups = new Map<string, ReceiptTax>();
  for (const line of lines) {
    const key = `${line.taxID}|${line.taxPercent ?? ""}`;
    const g = groups.get(key) ?? {
      taxCode: line.taxCode ?? null,
      taxPercent: line.taxPercent ?? null,
      taxID: line.taxID,
      taxAmount: 0,
      salesAmountWithTax: 0,
    };
    const lineTotal = line.receiptLineTotal;
    const rate = (line.taxPercent ?? 0) / 100;
    const tax = taxInclusive
      ? lineTotal - lineTotal / (1 + rate)
      : lineTotal * rate;
    g.taxAmount = round2(g.taxAmount + tax);
    g.salesAmountWithTax = round2(
      g.salesAmountWithTax + (taxInclusive ? lineTotal : lineTotal * (1 + rate)),
    );
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.taxID - b.taxID);
}

/** Fold a submitted receipt into the running fiscal-day counters. */
export function accumulateCounters(
  counters: FiscalDayCounter[],
  receipt: Receipt,
): void {
  const currency = receipt.receiptCurrency;
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
      existing.fiscalCounterValue = round2(existing.fiscalCounterValue + delta);
    } else {
      const c = create();
      c.fiscalCounterValue = round2(delta);
      counters.push(c);
    }
  };

  for (const t of receipt.receiptTaxes) {
    upsert(
      (c) =>
        c.fiscalCounterType === byTaxType &&
        c.fiscalCounterCurrency === currency &&
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
        c.fiscalCounterCurrency === currency &&
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
        c.fiscalCounterCurrency === currency &&
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
