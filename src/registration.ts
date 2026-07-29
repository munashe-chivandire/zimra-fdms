import { generateDeviceCsr, type DeviceKeyPair } from "./crypto.js";
import {
  FDMS_BASE_URLS,
  FdmsApiError,
  type ApiProblemDetails,
  type DeviceIdentity,
  type FdmsEnvironment,
  type RegisterDeviceRequest,
  type RegisterDeviceResponse,
} from "./types.js";

export interface RegisterDeviceOptions {
  environment?: FdmsEnvironment;
  /** CN prefix mandated by the tax authority. Defaults to "ZIMRA". */
  clientPrefix?: string;
}

export interface RegisteredDevice {
  keys: DeviceKeyPair;
  /** PEM device certificate issued by FDMS. Pair with keys.privateKeyPem for mTLS. */
  certificatePem: string;
  operationId: string;
}

/**
 * Full registration flow: generate ECDSA P-256 keys + CSR, call
 * POST /Public/v1/{deviceID}/RegisterDevice with the activation key,
 * and return the issued device certificate.
 *
 * This endpoint requires no client certificate — it is the bootstrap step.
 */
export async function registerDevice(
  device: DeviceIdentity,
  activationKey: string,
  options: RegisterDeviceOptions = {},
): Promise<RegisteredDevice> {
  const base = FDMS_BASE_URLS[options.environment ?? "test"];
  const keys = await generateDeviceCsr(
    device.serialNumber,
    device.deviceId,
    options.clientPrefix,
  );

  const body: RegisterDeviceRequest = {
    certificateRequest: keys.csrPem,
    activationKey,
  };

  const res = await fetch(
    `${base}/Public/v1/${device.deviceId}/RegisterDevice`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        DeviceModelName: device.modelName,
        DeviceModelVersion: device.modelVersion,
      },
      body: JSON.stringify(body),
    },
  );

  const operationId = res.headers.get("operationid") ?? undefined;

  if (!res.ok) {
    let problem: ApiProblemDetails | undefined;
    try {
      problem = (await res.json()) as ApiProblemDetails;
    } catch {
      /* non-JSON error body */
    }
    throw new FdmsApiError(res.status, problem, operationId);
  }

  const data = (await res.json()) as RegisterDeviceResponse;
  return {
    keys,
    certificatePem: data.certificate,
    operationId: data.operationID,
  };
}

/**
 * GET /Public/v1/GetServerCertificate — fetch the FDMS server certificate
 * chain (used later to validate server signatures on receipts).
 */
export async function getServerCertificate(
  environment: FdmsEnvironment = "test",
  thumbprint?: string,
): Promise<string[]> {
  const base = FDMS_BASE_URLS[environment];
  const url = new URL(`${base}/Public/v1/GetServerCertificate`);
  if (thumbprint) url.searchParams.set("thumbprint", thumbprint);

  const res = await fetch(url);
  if (!res.ok) {
    throw new FdmsApiError(res.status, undefined);
  }
  const data = (await res.json()) as { certificate: string[] };
  return data.certificate;
}
