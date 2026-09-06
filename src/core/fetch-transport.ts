/**
 * Transport over the platform's global fetch. Enough for the Public endpoints
 * (registration, server certificate), which need no client certificate.
 * Device endpoints need mTLS, which fetch cannot do; use a platform adapter.
 */
import {
  TransportError,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "./transport.js";

export class FetchTransport implements Transport {
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    if (typeof fetchFn !== "function") {
      throw new Error("No fetch on this runtime; pass a Transport to registerDevice");
    }
    this.fetchFn = fetchFn;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const res = await this.fetchFn(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: res.status, headers, text: await res.text() };
    } catch (err) {
      throw new TransportError(err instanceof Error ? err.message : String(err), err);
    } finally {
      clearTimeout(timer);
    }
  }
}
