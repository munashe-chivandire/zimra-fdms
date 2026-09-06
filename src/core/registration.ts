import { buildCsr, deviceCommonName } from "./csr.js";
import type { Signer } from "./signer.js";
import { FdmsClient, type Transport } from "./transport.js";
import { FetchTransport } from "./fetch-transport.js";
import {
  FDMS_BASE_URLS,
  FdmsApiError,
  type DeviceIdentity,
  type FdmsEnvironment,
  type RegisterDeviceRequest,
  type RegisterDeviceResponse,
} from "./types.js";

export interface RegisterDeviceOptions {
  environment?: FdmsEnvironment;
  /** Overrides the environment's URL, e.g. a local simulator. */
  baseUrl?: string;
  /** CN prefix mandated by the tax authority. Defaults to "ZIMRA". */
  clientPrefix?: string;
  /**
   * Transport for the Public endpoints, which need no client certificate.
   * Defaults to global fetch, which every supported runtime provides.
   */
  transport?: Transport;
}

export interface RegisteredDevice {
  /** PEM device certificate issued by FDMS. Pair it with the same Signer for mTLS. */
  certificatePem: string;
  csrPem: string;
  commonName: string;
  operationId: string;
}

/**
 * Register a device whose key already lives in `signer`: build and sign the
 * CSR, POST /Public/v1/{deviceID}/RegisterDevice with the activation key, and
 * return the issued certificate. The key never has to be exportable.
 */
export async function registerDevice(
  device: DeviceIdentity,
  activationKey: string,
  signer: Signer,
  options: RegisterDeviceOptions = {},
): Promise<RegisteredDevice> {
  const commonName = deviceCommonName(device.serialNumber, device.deviceId, options.clientPrefix);
  const csrPem = await buildCsr(signer, commonName);
  const client = new FdmsClient(device, options.transport ?? new FetchTransport(), {
    environment: options.environment,
    baseUrl: options.baseUrl,
  });
  const body: RegisterDeviceRequest = { certificateRequest: csrPem, activationKey };
  const data = await client.request<RegisterDeviceResponse>(
    "POST",
    client.publicPath("RegisterDevice"),
    body,
  );
  return { certificatePem: data.certificate, csrPem, commonName, operationId: data.operationID };
}

/**
 * GET /Public/v1/GetServerCertificate: the FDMS server certificate chain,
 * used to validate server signatures on receipts.
 */
export async function getServerCertificate(
  environment: FdmsEnvironment = "test",
  thumbprint?: string,
  transport: Transport = new FetchTransport(),
  baseUrl: string = FDMS_BASE_URLS[environment],
): Promise<string[]> {
  const query = thumbprint ? "?thumbprint=" + encodeURIComponent(thumbprint) : "";
  const url = baseUrl + "/Public/v1/GetServerCertificate" + query;
  const res = await transport.request({ method: "GET", url, headers: {}, timeoutMs: 30_000 });
  if (res.status < 200 || res.status >= 300) throw new FdmsApiError(res.status, undefined);
  return (JSON.parse(res.text) as { certificate: string[] }).certificate;
}
