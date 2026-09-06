/**
 * FDMS API types. Derived from ZIMRA's published OpenAPI specs (spec/*.json).
 */
import { ERROR_CATALOGUE, explainCode, supportCodeFor, type Explanation } from "./errors.js";

export type FdmsEnvironment = "test" | "production";

export const FDMS_BASE_URLS: Record<FdmsEnvironment, string> = {
  test: "https://fdmsapitest.zimra.co.zw",
  production: "https://fdmsapi.zimra.co.zw",
};

export interface DeviceIdentity {
  deviceId: number;
  serialNumber: string;
  modelName: string;
  modelVersion: string;
}

// ---------------------------------------------------------------------------
// Public (bootstrap) endpoints
// ---------------------------------------------------------------------------

export interface RegisterDeviceRequest {
  /** PEM-encoded CSR. Subject CN must be [CLIENT]-[serial]-[zero-padded 10-digit deviceId]. */
  certificateRequest: string;
  /** Case-insensitive 8-symbol activation key from the FDMS portal. */
  activationKey: string;
}

export interface RegisterDeviceResponse {
  operationID: string;
  /** PEM-encoded device certificate issued by the fiscalisation backend. */
  certificate: string;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type ReceiptType = "FiscalInvoice" | "CreditNote" | "DebitNote";
export type ReceiptLineType = "Sale" | "Discount";
export type MoneyType =
  | "Cash"
  | "Card"
  | "MobileWallet"
  | "Coupon"
  | "Credit"
  | "BankTransfer"
  | "Other";
export type FiscalCounterType =
  | "SaleByTax"
  | "SaleTaxByTax"
  | "CreditNoteByTax"
  | "CreditNoteTaxByTax"
  | "DebitNoteByTax"
  | "DebitNoteTaxByTax"
  | "BalanceByMoneyType"
  | "PayoutByTax"
  | "PayoutTaxByTax";
export type FiscalDayStatus =
  | "FiscalDayClosed"
  | "FiscalDayOpened"
  | "FiscalDayCloseInitiated"
  | "FiscalDayCloseFailed";
export type DeviceOperatingMode = "Online" | "Offline";

// ---------------------------------------------------------------------------
// Config / status
// ---------------------------------------------------------------------------

export interface TaxDefinition {
  taxID: number;
  taxName: string;
  /** Absent/null for exempt taxes. */
  taxPercent?: number | null;
  validFrom: string;
  validTill?: string | null;
}

export interface AddressDto {
  province?: string;
  city?: string;
  street?: string;
  houseNo?: string;
}

export interface GetConfigResponse {
  operationID: string;
  taxPayerName: string;
  taxPayerTIN: string;
  vatNumber?: string | null;
  deviceSerialNo: string;
  deviceBranchName: string;
  deviceBranchAddress: AddressDto;
  deviceBranchContacts?: { phoneNo?: string; email?: string } | null;
  deviceOperatingMode: DeviceOperatingMode;
  taxPayerDayMaxHrs: number;
  applicableTaxes: TaxDefinition[];
  certificateValidTill: string;
  qrUrl: string;
  taxpayerDayEndNotificationHrs: number;
}

export interface SignatureData {
  /** base64(SHA-256 of the canonical string) */
  hash: string;
  /** base64 signature of the canonical string (ECDSA P-256 / SHA-256) */
  signature: string;
}

export interface SignatureDataEx extends SignatureData {
  certificateThumbprint?: string;
}

export interface FiscalDayCounter {
  fiscalCounterType: FiscalCounterType;
  fiscalCounterCurrency: string;
  fiscalCounterTaxPercent?: number | null;
  fiscalCounterTaxID?: number | null;
  fiscalCounterMoneyType?: MoneyType | null;
  fiscalCounterValue: number;
}

export interface FiscalDayDocumentQuantity {
  receiptType: ReceiptType;
  receiptCurrency: string;
  receiptQuantity: number;
  receiptTotalAmount: number;
}

export interface GetStatusResponse {
  operationID: string;
  fiscalDayStatus: FiscalDayStatus;
  fiscalDayReconciliationMode?: string | null;
  fiscalDayServerSignature?: SignatureDataEx | null;
  fiscalDayClosed?: string | null;
  fiscalDayCounter?: FiscalDayCounter[] | null;
  lastReceiptGlobalNo?: number | null;
  lastFiscalDayNo?: number | null;
  fiscalDayClosingErrorCode?: string | null;
  /** Per spec: only present when the day is closed with Manual reconciliation. */
  fiscalDayDocumentQuantities?: FiscalDayDocumentQuantity[] | null;
}

// ---------------------------------------------------------------------------
// Fiscal day
// ---------------------------------------------------------------------------

export interface OpenDayRequest {
  fiscalDayNo?: number | null;
  /** Local time, format YYYY-MM-DDTHH:mm:ss (no timezone). */
  fiscalDayOpened: string;
}

export interface OpenDayResponse {
  operationID: string;
  fiscalDayNo: number;
}

export interface CloseDayRequest {
  fiscalDayNo: number;
  fiscalDayCounters: FiscalDayCounter[];
  fiscalDayDeviceSignature: SignatureData;
  /** Last receiptCounter value used in the fiscal day. */
  receiptCounter: number;
}

export interface CloseDayResponse {
  operationID: string;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface ReceiptLine {
  receiptLineType: ReceiptLineType;
  receiptLineNo: number;
  receiptLineHSCode?: string | null;
  receiptLineName: string;
  receiptLinePrice?: number | null;
  receiptLineQuantity: number;
  receiptLineTotal: number;
  taxCode?: string | null;
  taxPercent?: number | null;
  taxID: number;
}

export interface ReceiptTax {
  taxCode?: string | null;
  taxPercent?: number | null;
  taxID: number;
  taxAmount: number;
  salesAmountWithTax: number;
}

export interface Payment {
  moneyTypeCode: MoneyType;
  paymentAmount: number;
}

export interface CreditDebitNote {
  receiptID?: number | null;
  deviceID?: number | null;
  receiptGlobalNo?: number | null;
  fiscalDayNo?: number | null;
}

export interface BuyerData {
  buyerRegisterName?: string;
  buyerTradeName?: string;
  vatNumber?: string;
  buyerTIN?: string;
  buyerContacts?: { phoneNo?: string; email?: string };
  buyerAddress?: AddressDto;
}

export interface Receipt {
  receiptType: ReceiptType;
  receiptCurrency: string;
  /** Sequential within the fiscal day, starting at 1. */
  receiptCounter: number;
  /** Sequential across the device lifetime. */
  receiptGlobalNo: number;
  invoiceNo: string;
  buyerData?: BuyerData | null;
  receiptNotes?: string | null;
  /** Local time, format YYYY-MM-DDTHH:mm:ss (no timezone). */
  receiptDate: string;
  creditDebitNote?: CreditDebitNote | null;
  receiptLinesTaxInclusive: boolean;
  receiptLines: ReceiptLine[];
  receiptTaxes: ReceiptTax[];
  receiptPayments: Payment[];
  receiptTotal: number;
  receiptPrintForm?: "Receipt48" | "InvoiceA4" | null;
  receiptDeviceSignature: SignatureData;
}

export interface SubmitReceiptRequest {
  receipt: Receipt;
}

export interface ValidationError {
  validationErrorCode?: string;
  validationErrorColor?: string;
  validationErrorDescription?: string;
}

export interface SubmitReceiptResponse {
  operationID: string;
  receiptID: number;
  serverDate: string;
  receiptServerSignature: SignatureDataEx;
  validationErrors?: ValidationError[] | null;
}

export interface PingResponse {
  operationID: string;
  reportingFrequency?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errorCode?: string;
  [key: string]: unknown;
}

/** One-line hints per code, derived from the error catalogue. */
export const FDMS_ERROR_HINTS: Record<string, string> = Object.fromEntries(
  Object.values(ERROR_CATALOGUE).map((e) => [e.code, e.cause]),
);

export class FdmsApiError extends Error {
  readonly hint?: string;
  /** `CODE-OPERATIONID`, for a user to read out to support. */
  readonly supportCode: string;
  constructor(
    public readonly status: number,
    public readonly problem: ApiProblemDetails | undefined,
    public readonly operationId?: string,
  ) {
    const code = problem?.errorCode;
    const hint = code ? FDMS_ERROR_HINTS[code] : undefined;
    super(
      [
        problem?.detail ?? problem?.title ?? `FDMS request failed with HTTP ${status}`,
        code ? `(errorCode: ${code})` : undefined,
        hint,
      ]
        .filter(Boolean)
        .join(" "),
    );
    this.name = "FdmsApiError";
    this.hint = hint;
    this.supportCode = supportCodeFor(code ?? `HTTP${status}`, operationId);
  }

  /** Cause, fix, colour and whether the day is still closable. */
  explain(): Explanation {
    return explainCode(this.problem?.errorCode ?? `HTTP${this.status}`, this.operationId);
  }
}

/** Explain a validationErrors entry from SubmitReceipt. */
export function explainValidationError(v: ValidationError, operationId?: string): Explanation {
  const ex = explainCode(v.validationErrorCode ?? "?", operationId);
  if (ex.colour === "Unknown" && v.validationErrorColor) {
    ex.colour = v.validationErrorColor as Explanation["colour"];
    ex.dayStillClosable = v.validationErrorColor.toLowerCase() !== "red";
  }
  if (v.validationErrorDescription && ex.cause.startsWith("No explanation")) ex.cause = v.validationErrorDescription;
  return ex;
}
