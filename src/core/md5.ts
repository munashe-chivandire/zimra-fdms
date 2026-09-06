/**
 * MD5 in plain TypeScript, used only for the 16-hex-character checksum in the
 * receipt verification QR code. WebCrypto does not implement MD5 on any
 * runtime, so this cannot be delegated to the platform.
 */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const T = /* @__PURE__ */ (() => {
  const t = new Uint32Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  return t;
})();

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  // 64-bit little-endian bit length.
  const lo = (len << 3) >>> 0;
  const hi = Math.floor(len / 0x20000000);
  buf[total - 8] = lo & 0xff;
  buf[total - 7] = (lo >>> 8) & 0xff;
  buf[total - 6] = (lo >>> 16) & 0xff;
  buf[total - 5] = (lo >>> 24) & 0xff;
  buf[total - 4] = hi & 0xff;
  buf[total - 3] = (hi >>> 8) & 0xff;
  buf[total - 2] = (hi >>> 16) & 0xff;
  buf[total - 1] = (hi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      m[i] =
        (buf[j]! | (buf[j + 1]! << 8) | (buf[j + 2]! << 16) | (buf[j + 3]! << 24)) >>> 0;
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + T[i]! + m[g]!) >>> 0;
      b = (b + rotl(sum, S[i]!)) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i]! & 0xff;
    out[i * 4 + 1] = (words[i]! >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i]! >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i]! >>> 24) & 0xff;
  }
  return out;
}
