/**
 * Node Transport: node:https with mutual TLS. One keep-alive agent per device
 * holds the TLS context, so the handshake and the PEM parse happen once per
 * process rather than once per receipt.
 */
import { Agent, request as httpsRequest } from "node:https";
import {
  TransportError,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "../core/transport.js";

export interface MtlsIdentity {
  /** PEM device certificate issued by RegisterDevice/IssueCertificate. */
  certificatePem: string;
  /** PEM PKCS#8 private key matching the certificate. */
  privateKeyPem: string;
}

export interface NodeTransportOptions {
  /** Idle keep-alive time in ms. Default 30_000. */
  keepAliveMs?: number;
  /** Extra CA certificates, e.g. a local simulator's root. */
  ca?: string | string[];
  /** Disable server certificate checks. Only for a local simulator. */
  rejectUnauthorized?: boolean;
}

export class NodeTransport implements Transport {
  private readonly agent: Agent;

  constructor(identity: MtlsIdentity | undefined, options: NodeTransportOptions = {}) {
    this.agent = new Agent({
      keepAlive: true,
      keepAliveMsecs: options.keepAliveMs ?? 30_000,
      maxSockets: 4,
      cert: identity?.certificatePem || undefined,
      key: identity?.privateKeyPem || undefined,
      ca: options.ca,
      rejectUnauthorized: options.rejectUnauthorized,
    });
  }

  request(req: TransportRequest): Promise<TransportResponse> {
    const url = new URL(req.url);
    const body = req.body === undefined ? undefined : Buffer.from(req.body, "utf-8");
    return new Promise((resolve, reject) => {
      const r = httpsRequest(
        {
          agent: this.agent,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: req.method,
          headers: { ...req.headers, ...(body ? { "Content-Length": body.length } : {}) },
          timeout: req.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", (e) => reject(new TransportError(e.message, e)));
          res.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") headers[k.toLowerCase()] = v;
              else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              text: Buffer.concat(chunks).toString("utf-8"),
            });
          });
        },
      );
      r.on("timeout", () => {
        r.destroy(new Error("FDMS request timed out after " + req.timeoutMs + "ms"));
      });
      r.on("error", (e) => reject(new TransportError(e.message, e)));
      if (body) r.write(body);
      r.end();
    });
  }

  /** Close idle sockets. Call on shutdown so the process can exit promptly. */
  destroy(): void {
    this.agent.destroy();
  }
}
