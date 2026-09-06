/**
 * The smallest DER writer that can emit a PKCS#10 certificate request.
 *
 * @peculiar/x509 does this already, but it needs a WebCrypto provider to hold
 * the key, which is exactly what a hardware-backed key cannot supply. Building
 * the request here means the Signer only ever has to sign bytes.
 */
import { concatBytes } from "./bytes.js";

function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

export function derTlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(content.length), content);
}

export const derSequence = (...items: Uint8Array[]) => derTlv(0x30, concatBytes(...items));
export const derSet = (...items: Uint8Array[]) => derTlv(0x31, concatBytes(...items));

export function derInteger(value: number): Uint8Array {
  if (value < 0) throw new Error("derInteger only handles non-negative values");
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return derTlv(0x02, new Uint8Array(bytes));
}

/** Encode a dotted OID, e.g. "1.2.840.10045.4.3.2" for ecdsa-with-SHA256. */
export function derOid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  if (parts.length < 2) throw new Error(`Not an OID: ${dotted}`);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let v = part >>> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(...chunk);
  }
  return derTlv(0x06, new Uint8Array(bytes));
}

const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/;

/**
 * PrintableString where the value allows it, UTF8String otherwise. FDMS device
 * common names are printable, and matching the encoding @peculiar/x509 picked
 * keeps requests from the two builders byte-identical.
 */
export function derString(value: string): Uint8Array {
  if (PRINTABLE.test(value)) {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i);
    return derTlv(0x13, bytes);
  }
  // utf8Bytes is imported lazily to keep this module free of cycles.
  const enc: number[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) enc.push(cp);
    else if (cp < 0x800) enc.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) enc.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else enc.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return derTlv(0x0c, new Uint8Array(enc));
}

/** BIT STRING with a zero unused-bits prefix, which is all X.509 needs here. */
export function derBitString(content: Uint8Array): Uint8Array {
  return derTlv(0x03, concatBytes(new Uint8Array([0]), content));
}

/** Context-specific constructed tag, e.g. [0] for CSR attributes. */
export function derContext(index: number, content: Uint8Array): Uint8Array {
  return derTlv(0xa0 | index, content);
}
