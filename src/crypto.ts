import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

x509.cryptoProvider.set(webcrypto as Crypto);

export interface DeviceKeyPair {
  /** PKCS#8 PEM private key. Store securely; never leaves the device. */
  privateKeyPem: string;
  /** SPKI PEM public key. */
  publicKeyPem: string;
  /** PEM certificate signing request to send to RegisterDevice. */
  csrPem: string;
  /** The exact CN placed in the CSR subject. */
  commonName: string;
}

/**
 * Device name required by FDMS in the CSR subject CN:
 * [CLIENT]-[serial]-[zero-padded 10-digit deviceId], e.g. ZIMRA-GOKOSDK001-0000037367
 */
export function deviceCommonName(
  serialNumber: string,
  deviceId: number,
  client = "ZIMRA",
): string {
  return `${client}-${serialNumber}-${String(deviceId).padStart(10, "0")}`;
}

/**
 * Generates an ECDSA P-256 key pair and a CSR in the format FDMS expects
 * (spec: ECC secp256r1 preferred, signature ecdsa-with-SHA256).
 */
export async function generateDeviceCsr(
  serialNumber: string,
  deviceId: number,
  client = "ZIMRA",
): Promise<DeviceKeyPair> {
  const alg = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  } as const;

  const keys = await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ]);

  const commonName = deviceCommonName(serialNumber, deviceId, client);

  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${commonName}`,
    keys,
    signingAlgorithm: alg,
  });

  const privateKeyPkcs8 = await webcrypto.subtle.exportKey(
    "pkcs8",
    keys.privateKey,
  );
  const publicKeySpki = await webcrypto.subtle.exportKey(
    "spki",
    keys.publicKey,
  );

  return {
    privateKeyPem: x509.PemConverter.encode(privateKeyPkcs8, "PRIVATE KEY"),
    publicKeyPem: x509.PemConverter.encode(publicKeySpki, "PUBLIC KEY"),
    csrPem: csr.toString("pem"),
    commonName,
  };
}
