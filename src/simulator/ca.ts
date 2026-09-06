/**
 * A throwaway certificate authority for the simulator: a self-signed root,
 * a server certificate for localhost, and device certificates issued from
 * the same PKCS#10 requests the SDK sends to ZIMRA. Mutual TLS is real,
 * not stubbed, so a Transport adapter is exercised the way production is.
 */
import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

x509.cryptoProvider.set(webcrypto as Crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

function validity(days: number): { notBefore: Date; notAfter: Date } {
  const notBefore = new Date(Date.now() - 60_000);
  return { notBefore, notAfter: new Date(notBefore.getTime() + days * 86_400_000) };
}

let serial = 1;
const nextSerial = () => (serial++).toString(16).padStart(2, "0");

export interface PemIdentity {
  certificatePem: string;
  privateKeyPem: string;
}

export class SimulatorCa {
  private constructor(
    private readonly keys: webcrypto.CryptoKeyPair,
    readonly certificate: x509.X509Certificate,
  ) {}

  static async create(name = "zimra-fdms simulator CA"): Promise<SimulatorCa> {
    const keys = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: nextSerial(),
      name: `CN=${name}`,
      ...validity(3650),
      signingAlgorithm: ALG,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 1, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      ],
    });
    return new SimulatorCa(keys, cert);
  }

  get caPem(): string {
    return this.certificate.toString("pem");
  }

  /** Thumbprint as FDMS reports it in GetStatus: SHA-1 hex, upper case. */
  async thumbprint(): Promise<string> {
    const t = await this.certificate.getThumbprint("SHA-1");
    return Buffer.from(t).toString("hex").toUpperCase();
  }

  async serverIdentity(hosts: string[] = ["localhost"]): Promise<PemIdentity> {
    const keys = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: nextSerial(),
      subject: `CN=${hosts[0]}`,
      issuer: this.certificate.subject,
      ...validity(825),
      signingAlgorithm: ALG,
      publicKey: keys.publicKey,
      signingKey: this.keys.privateKey,
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          ...hosts.map((h) => ({ type: "dns" as const, value: h })),
          { type: "ip", value: "127.0.0.1" },
        ]),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      ],
    });
    return {
      certificatePem: cert.toString("pem"),
      privateKeyPem: x509.PemConverter.encode(
        await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
        "PRIVATE KEY",
      ),
    };
  }

  /**
   * Issue a device certificate from a PEM CSR, as RegisterDevice and
   * IssueCertificate do. Rejects a CSR whose signature does not verify,
   * which is what a wrong Signer implementation produces.
   */
  async issueFromCsr(csrPem: string, days = 365): Promise<{ certificatePem: string; commonName: string }> {
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    if (!(await csr.verify())) throw new Error("CSR signature does not verify");
    const cn = csr.subjectName.getField("CN")[0];
    if (!cn) throw new Error("CSR has no CN");
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: nextSerial(),
      subject: csr.subject,
      issuer: this.certificate.subject,
      ...validity(days),
      signingAlgorithm: ALG,
      publicKey: csr.publicKey,
      signingKey: this.keys.privateKey,
      extensions: [new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth])],
    });
    return { certificatePem: cert.toString("pem"), commonName: cn };
  }

  /** Sign bytes with the CA key, for receiptServerSignature. DER output. */
  async sign(data: Uint8Array): Promise<Uint8Array> {
    const raw = new Uint8Array(await webcrypto.subtle.sign(ALG, this.keys.privateKey, new Uint8Array(data)));
    const { p1363ToDer } = await import("../core/signer.js");
    return p1363ToDer(raw);
  }
}

/** Public key of a DER or PEM certificate, ready for ECDSA verify. */
export async function certificatePublicKey(certDerOrPem: Uint8Array | string): Promise<CryptoKey> {
  const cert = new x509.X509Certificate(
    typeof certDerOrPem === "string" ? certDerOrPem : new Uint8Array(certDerOrPem),
  );
  return cert.publicKey.export(ALG, ["verify"]);
}

export function certificateCommonName(certDerOrPem: Uint8Array | string): string {
  const cert = new x509.X509Certificate(
    typeof certDerOrPem === "string" ? certDerOrPem : new Uint8Array(certDerOrPem),
  );
  return cert.subjectName.getField("CN")[0] ?? "";
}
