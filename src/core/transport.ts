/**
 * HTTP with mutual TLS is the second thing a platform has to own. The adapter
 * holds the client identity, which must be the same key as the Signer, and
 * hands back headers so the core can learn the server clock.
 */
import { FDMS_BASE_URLS, FdmsApiError, type ApiProblemDetails, type DeviceIdentity, type FdmsEnvironment } from "./types.js";

export interface TransportRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** UTF-8 JSON body, already serialised. */
  body?: string;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  text: string;
}

export interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
}

export interface FdmsClientOptions {
  environment?: FdmsEnvironment;
  /** Request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Called with every response Date header, so a Clock can learn the offset. */
  onServerDate?: (serverDate: Date, roundTripMs: number) => void;
}

/**
 * Typed FDMS calls over a Transport: builds device paths and headers, parses
 * JSON, turns problem-details bodies into FdmsApiError.
 */
export class FdmsClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly device: DeviceIdentity,
    private readonly transport: Transport,
    private readonly options: FdmsClientOptions = {},
  ) {
    this.baseUrl = FDMS_BASE_URLS[options.environment ?? "test"];
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const started = Date.now();
    const res = await this.transport.request({
      method,
      url: this.baseUrl + path,
      headers: {
        Accept: "application/json",
        DeviceModelName: this.device.modelName,
        DeviceModelVersion: this.device.modelVersion,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload,
      timeoutMs: this.timeoutMs,
    });

    const date = res.headers["date"];
    if (date && this.options.onServerDate) {
      const parsed = new Date(date);
      if (!Number.isNaN(parsed.getTime())) this.options.onServerDate(parsed, Date.now() - started);
    }

    const operationId = res.headers["operationid"];
    if (res.status < 200 || res.status >= 300) {
      let problem: ApiProblemDetails | undefined;
      try {
        problem = JSON.parse(res.text) as ApiProblemDetails;
      } catch {
        /* non-JSON body */
      }
      throw new FdmsApiError(res.status, problem, operationId);
    }
    return (res.text ? JSON.parse(res.text) : undefined) as T;
  }

  devicePath(endpoint: string): string {
    return `/Device/v1/${this.device.deviceId}/${endpoint}`;
  }

  publicPath(endpoint: string): string {
    return `/Public/v1/${this.device.deviceId}/${endpoint}`;
  }
}

/**
 * A network failure, as opposed to an FDMS rejection. The offline queue keeps
 * a receipt on a network error and stops on anything else. Adapters throw
 * TransportError so the check does not depend on Node errno codes.
 */
export class TransportError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TransportError";
  }
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof TransportError) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    /timed out|network request failed/i.test(err.message)
  );
}
