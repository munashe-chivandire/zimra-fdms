/**
 * What FDMS's codes mean and what to do about them.
 *
 * Observed behaviour is authoritative; entries marked `observed` were seen
 * on ZIMRA's test environment on device 37367. The rest come from the API
 * documentation and are starting points until seen live.
 */
export type ErrorColour = "Red" | "Yellow" | "Grey";

export interface ErrorCatalogueEntry {
  code: string;
  /** Red: accepted but the device can no longer close the day. Yellow: accepted, warning only. Grey: request refused outright. */
  colour: ErrorColour;
  cause: string;
  fix: string;
  observed: boolean;
}

export const ERROR_CATALOGUE: Record<string, ErrorCatalogueEntry> = {
  RCPT010: {
    code: "RCPT010",
    colour: "Red",
    cause: "Receipt device signature does not verify. The canonical string or the hash chain differs from what FDMS computed.",
    fix: "Check field order, cents conversion, tax block, previousReceiptHash and that the signature is ASN.1 DER. Run zimra-fdms-conformance.",
    observed: false,
  },
  RCPT011: {
    code: "RCPT011",
    colour: "Red",
    cause: "receiptCounter is not the next number in this fiscal day.",
    fix: "Restore the persisted day state before submitting; do not reuse a device from two processes.",
    observed: false,
  },
  RCPT012: {
    code: "RCPT012",
    colour: "Red",
    cause: "receiptGlobalNo is not one more than the highest number FDMS holds for the device. Usually the device opened the day from GetStatus.lastReceiptGlobalNo, which lags after a future-dated receipt.",
    fix: "Keep the highest issued number locally (the SDK does with a Storage) and let openDay() take the larger. The day can only be closed by ZIMRA now.",
    observed: true,
  },
  RCPT013: {
    code: "RCPT013",
    colour: "Red",
    cause: "A tax ID on the receipt is not in the device's tax table.",
    fix: "Use taxIDs from getConfig().applicableTaxes.",
    observed: false,
  },
  RCPT014: {
    code: "RCPT014",
    colour: "Yellow",
    cause: "receiptDate is earlier than the time the fiscal day was opened.",
    fix: "Use the server-corrected clock; do not backdate receipts before openDay.",
    observed: true,
  },
  RCPT020: {
    code: "RCPT020",
    colour: "Red",
    cause: "receiptTotal does not equal the sum of the lines (plus tax when exclusive).",
    fix: "Let the SDK compute totals in integer cents; do not pass rounded floats.",
    observed: false,
  },
  RCPT021: {
    code: "RCPT021",
    colour: "Red",
    cause: "Payments do not add up to receiptTotal.",
    fix: "Sum payments in cents before submitting; the SDK refuses this locally.",
    observed: false,
  },
  RCPT030: {
    code: "RCPT030",
    colour: "Red",
    cause: "receiptDate is not later than the previous receipt's. Follows a future-dated receipt (RCPT031) or a clock that went backwards.",
    fix: "Wait until real time passes the last receiptDate, or issue with the server-corrected clock. The day can only be closed by ZIMRA now.",
    observed: true,
  },
  RCPT031: {
    code: "RCPT031",
    colour: "Yellow",
    cause: "receiptDate is ahead of server time.",
    fix: "Fix the device clock or rely on ServerCorrectedClock. Every later receipt must be dated after this one, so the next real-time receipt gets RCPT030.",
    observed: true,
  },
  DEV01: {
    code: "DEV01",
    colour: "Grey",
    cause: "Device is not active: blacklisted, suspended or not yet approved.",
    fix: "Check the device on the FDMS portal.",
    observed: false,
  },
  DEV02: {
    code: "DEV02",
    colour: "Grey",
    cause: "The device certificate is about to expire.",
    fix: "Call renewCertificate() and reconnect with the new certificate.",
    observed: false,
  },
  FDC01: {
    code: "FDC01",
    colour: "Grey",
    cause: "A fiscal day is already open.",
    fix: "Close it (or recover the close from server counters) before opening another.",
    observed: false,
  },
  FDC02: {
    code: "FDC02",
    colour: "Grey",
    cause: "No fiscal day is open.",
    fix: "Call openDay() first.",
    observed: false,
  },
  BadCertificateSignature: {
    code: "BadCertificateSignature",
    colour: "Grey",
    cause: "CloseDay signature did not verify. FDMS signs over the date the day was opened, which GetStatus never reports.",
    fix: "Sign with the fiscalDayDate the day was opened on; the CLI takes --date for a stateless close.",
    observed: true,
  },
  ReceiptsWithValidationErrors: {
    code: "ReceiptsWithValidationErrors",
    colour: "Grey",
    cause: "The day holds a receipt with a Red validation error, so the device may not close it.",
    fix: "Only ZIMRA can close this day. Ask via the fdmsops portal, then open the next day.",
    observed: true,
  },
};

export interface Explanation {
  code: string;
  colour: ErrorColour | "Unknown";
  cause: string;
  fix: string;
  /** False once a Red error has been accepted into the open day. */
  dayStillClosable: boolean;
  /** Short code a non-technical user can read out to support. */
  supportCode: string;
}

/** Plain-language explanation of a code, with a support code built from the operationId. */
export function explainCode(code: string, operationId?: string): Explanation {
  const entry = ERROR_CATALOGUE[code];
  return {
    code,
    colour: entry?.colour ?? "Unknown",
    cause: entry?.cause ?? "No explanation on file for this code.",
    fix: entry?.fix ?? "Quote the support code to ZIMRA or the SDK maintainers.",
    dayStillClosable: entry?.colour !== "Red",
    supportCode: supportCodeFor(code, operationId),
  };
}

/**
 * `RCPT030-0HN5` style: the code plus the first path segment of the FDMS
 * operationId, which is what ZIMRA support searches on.
 */
export function supportCodeFor(code: string, operationId?: string): string {
  const op = (operationId ?? "").split(":")[0]!.slice(0, 12).toUpperCase();
  return op ? `${code}-${op}` : code;
}
