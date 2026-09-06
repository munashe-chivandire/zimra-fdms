/**
 * Signer over an exportable PKCS#8 PEM key, the 0.3.x default. Uses Node's
 * WebCrypto, imports the key once and converts the P1363 output to DER.
 */
import { webcrypto } from "node:crypto";
import { p1363ToDer, type Signer } from "../core/signer.js";
import { pemToDer, derToPem } from "../core/bytes.js";

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
type WebKey = Awaited<ReturnType<typeof webcrypto.subtle.importKey>>;

/** Copy into a fresh ArrayBuffer so the type satisfies BufferSource. */
const owned = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export class PemSigner implements Signer {
  private key?: Promise<WebKey>;
  private spki?: Promise<Uint8Array>;

  constructor(private readonly privateKeyPem: string) {}

  private importKey(): Promise<WebKey> {
    // Imported once, then reused for every receipt.
    this.key ??= webcrypto.subtle.importKey("pkcs8", owned(pemToDer(this.privateKeyPem)), ALG, true, ["sign"]);
    return this.key;
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    const key = await this.importKey();
    const raw = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, owned(data));
    return p1363ToDer(new Uint8Array(raw));
  }

  async publicKeySpki(): Promise<Uint8Array> {
    this.spki ??= (async () => {
      // WebCrypto cannot export the public half of a private key directly:
      // export as JWK, drop `d`, re-import as public, export as SPKI.
      const jwk = await webcrypto.subtle.exportKey("jwk", await this.importKey());
      const { d: _d, ...pub } = jwk;
      const pubKey = await webcrypto.subtle.importKey("jwk", { ...pub, key_ops: ["verify"] }, ALG, true, ["verify"]);
      return new Uint8Array(await webcrypto.subtle.exportKey("spki", pubKey));
    })();
    return this.spki;
  }

  /** SPKI PEM of the public key, for backup files and debugging. */
  async publicKeyPem(): Promise<string> {
    return derToPem(await this.publicKeySpki(), "PUBLIC KEY");
  }
}

/**
 * Generate a fresh exportable P-256 key and return it as PEM plus a Signer.
 * Adapters with hardware keys (Android Keystore, HSM) expose their own
 * createSigner() that never returns a PEM.
 */
export async function generatePemSigner(): Promise<{ privateKeyPem: string; publicKeyPem: string; signer: PemSigner }> {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const spki = new Uint8Array(await webcrypto.subtle.exportKey("spki", keys.publicKey));
  const privateKeyPem = derToPem(pkcs8, "PRIVATE KEY");
  return { privateKeyPem, publicKeyPem: derToPem(spki, "PUBLIC KEY"), signer: new PemSigner(privateKeyPem) };
}
