import { createHash } from "node:crypto";

/**
 * Data content of the verification QR code printed on every fiscal receipt:
 * qrUrl + deviceId(10 digits) + receiptDate(ddMMyyyy) + receiptGlobalNo(10
 * digits) + first 16 hex chars of MD5 over the raw signature bytes.
 *
 * Scanning it against https://fdms.zimra.co.zw validates the invoice.
 */
export function receiptQrData(params: {
  /** qrUrl from GetConfig, e.g. "https://fdmsapitest.zimra.co.zw/" */
  qrUrl: string;
  deviceId: number;
  /** The receipt's receiptDate (device local time). */
  receiptDate: Date;
  receiptGlobalNo: number;
  /** base64 device signature of the receipt (receiptDeviceSignature.signature). */
  deviceSignatureBase64: string;
}): string {
  const sigBytes = Buffer.from(params.deviceSignatureBase64, "base64");
  const md5_16 = createHash("md5").update(sigBytes).digest("hex").slice(0, 16);

  const p = (n: number) => String(n).padStart(2, "0");
  const d = params.receiptDate;
  const ddMMyyyy = `${p(d.getDate())}${p(d.getMonth() + 1)}${d.getFullYear()}`;

  const base = params.qrUrl.endsWith("/") ? params.qrUrl : params.qrUrl + "/";
  return (
    base +
    String(params.deviceId).padStart(10, "0") +
    ddMMyyyy +
    String(params.receiptGlobalNo).padStart(10, "0") +
    md5_16
  );
}
