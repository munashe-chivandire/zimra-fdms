/**
 * The one interface that decides where a device key can live.
 *
 * 0.3.x assumed an exportable PKCS#8 PEM, which rules out Android Keystore,
 * StrongBox, an HSM slot and cloud KMS. Behind this interface the core never
 * sees key material, only signatures.
 */
import { toBase64, concatBytes, utf8Bytes } from "./bytes.js";
import { sha256Base64 } from "./sha256.js";
import type { SignatureData } from "./types.js";

export interface Signer {
  /**
   * ASN.1 DER ECDSA P-256 signature over SHA-256 of `data`. The implementation
   * hashes; callers pass the message, not a digest. FDMS rejects raw P1363
   * with RCPT020 / BadCertificateSignature, so DER is not optional.
   */
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** The matching public key as a DER SubjectPublicKeyInfo, for CSR building. */
  publicKeySpki(): Promise<Uint8Array>;
}

export type EcdsaSignatureFormat = "p1363" | "der";

/** Convert a raw IEEE P1363 (r||s) ECDSA signature to ASN.1 DER encoding. */
export function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const half = p1363.length / 2;
  const encodeInt = (bytes: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.subarray(i);
    if (v[0]! & 0x80) v = concatBytes(new Uint8Array([0]), v);
    return concatBytes(new Uint8Array([0x02, v.length]), v);
  };
  const r = encodeInt(p1363.subarray(0, half));
  const s = encodeInt(p1363.subarray(half));
  return concatBytes(new Uint8Array([0x30, r.length + s.length]), r, s);
}

/**
 * Convert a DER ECDSA signature back to fixed-width P1363, for the rare
 * caller that asked for `signatureFormat: "p1363"`. Signers hand back DER, so
 * this is the one place the conversion runs backwards.
 */
export function derToP1363(der: Uint8Array, byteLength = 32): Uint8Array {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("Not a DER SEQUENCE");
  if (der[i]! & 0x80) i += 1 + (der[i]! & 0x7f);
  else i += 1;
  const readInt = (): Uint8Array => {
    if (der[i++] !== 0x02) throw new Error("Not a DER INTEGER");
    const len = der[i++]!;
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > byteLength && v[0] === 0) v = v.subarray(1);
    const out = new Uint8Array(byteLength);
    out.set(v, byteLength - v.length);
    return out;
  };
  return concatBytes(readInt(), readInt());
}

/**
 * Hash and sign a canonical FDMS string. The hash is SHA-256 of the string,
 * base64-encoded; the signature is over the same bytes.
 */
export async function signCanonicalString(
  signer: Signer,
  canonical: string,
  format: EcdsaSignatureFormat = "der",
): Promise<SignatureData> {
  const der = await signer.sign(utf8Bytes(canonical));
  return {
    hash: sha256Base64(canonical),
    signature: toBase64(format === "der" ? der : derToP1363(der)),
  };
}
