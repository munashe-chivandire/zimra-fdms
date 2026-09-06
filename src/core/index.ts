/**
 * zimra-fdms/core: the fiscal engine with no platform imports. Everything
 * here runs on Node, Bun, Deno, Hermes and browsers unchanged. Platforms
 * supply a Signer and a Transport; see zimra-fdms/node for the Node ones.
 */
export {
  registerDevice,
  getServerCertificate,
  type RegisterDeviceOptions,
  type RegisteredDevice,
} from "./registration.js";
export { buildCsr, deviceCommonName } from "./csr.js";
export {
  FiscalDevice,
  DayNotClosableError,
  PendingSubmitError,
  buildReceiptTaxes,
  accumulateCounters,
  type FiscalDeviceDeps,
  type FiscalDeviceOptions,
  type ReceiptInput,
  type RedValidationError,
  type ReceiptLineInput,
  type FiscalDayState,
  type SubmittedReceipt,
  type PreparedReceipt,
  type ReconcileResult,
} from "./device.js";
export {
  OfflineReceiptQueue,
  MemoryQueueStorage,
  journalFromQueueStorage,
  type QueueStorage,
  type FlushResult,
} from "./queue.js";
export {
  receiptSigningString,
  fiscalDaySigningString,
  concatenateReceiptTaxes,
  toCents,
  fdmsDate,
  fdmsDateTime,
  formatTaxPercent,
} from "./signing.js";
export {
  type Signer,
  type EcdsaSignatureFormat,
  signCanonicalString,
  p1363ToDer,
  derToP1363,
} from "./signer.js";
export { sha256, sha256Base64 } from "./sha256.js";
export { md5 } from "./md5.js";
export {
  utf8Bytes,
  utf8String,
  toBase64,
  fromBase64,
  toHex,
  concatBytes,
  pemToDer,
  derToPem,
} from "./bytes.js";
export {
  FdmsClient,
  TransportError,
  isNetworkError,
  type Transport,
  type TransportRequest,
  type TransportResponse,
  type FdmsClientOptions,
} from "./transport.js";
export { FetchTransport } from "./fetch-transport.js";
export { ServerCorrectedClock, systemClock, type Clock } from "./clock.js";
export { receiptQrData } from "./qr.js";
export {
  cents,
  fromCents,
  isMoney,
  amountToCents,
  centsToAmount,
  formatCents,
  moneyFromJsonNumber,
  receiptInputFromJson,
  type Money,
} from "./money.js";
export { MemoryStorage, guardedStorage, type Storage } from "./storage.js";
export { MemoryJournal, type Journal, type JournalEntry } from "./journal.js";
export * from "./types.js";
export { ERROR_CATALOGUE, explainCode, supportCodeFor, type ErrorCatalogueEntry, type ErrorColour, type Explanation } from "./errors.js";
