import { request as httpsRequest } from "node:https";
import {
  FDMS_BASE_URLS,
  FdmsApiError,
  type ApiProblemDetails,
  type DeviceIdentity,
  type FdmsEnvironment,
} from "./types.js";

export interface MtlsIdentity {
  /** PEM device certificate issued by RegisterDevice/IssueCertificate. */
  certificatePem: string;
  /** PEM PKCS#8 private key matching the certificate. */
  privateKeyPem: string;
}

export interface FdmsHttpOptions {
  environment?: FdmsEnvironment;
  /** Request timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

/**
 * Minimal HTTPS transport with mutual TLS. Uses node:https directly so the
 * SDK has zero runtime HTTP dependencies.
 */
export class FdmsHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly device: DeviceIdentity,
    private readonly identity: MtlsIdentity | undefined,
    options: FdmsHttpOptions = {},
  ) {
    this.baseUrl = FDMS_BASE_URLS[options.environment ?? "test"];
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const { status, text, operationId } = await new Promise<{
      status: number;
      text: string;
      operationId?: string;
    }>((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method,
          headers: {
            Accept: "application/json",
            DeviceModelName: this.device.modelName,
            DeviceModelVersion: this.device.modelVersion,
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                }
              : {}),
          },
          cert: this.identity?.certificatePem,
          key: this.identity?.privateKeyPem,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf-8"),
              operationId: res.headers["operationid"] as string | undefined,
            }),
          );
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error(`FDMS request timed out after ${this.timeoutMs}ms`));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });

    if (status < 200 || status >= 300) {
      let problem: ApiProblemDetails | undefined;
      try {
        problem = JSON.parse(text) as ApiProblemDetails;
      } catch {
        /* non-JSON body */
      }
      throw new FdmsApiError(status, problem, operationId);
    }

    return (text ? JSON.parse(text) : undefined) as T;
  }

  devicePath(endpoint: string): string {
    return `/Device/v1/${this.device.deviceId}/${endpoint}`;
  }
}
