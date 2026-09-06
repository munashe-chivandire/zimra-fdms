/**
 * Exportable device keys for Node, kept for backup files and 0.3.x callers.
 * The CSR itself is built by the portable core.
 */
import { buildCsr, deviceCommonName } from "../core/csr.js";
import { generatePemSigner } from "./pem-signer.js";

export { deviceCommonName };

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
 * Generates an ECDSA P-256 key pair and a CSR in the format FDMS expects
 * (spec: ECC secp256r1 preferred, signature ecdsa-with-SHA256).
 */
export async function generateDeviceCsr(
  serialNumber: string,
  deviceId: number,
  client = "ZIMRA",
): Promise<DeviceKeyPair> {
  const { privateKeyPem, publicKeyPem, signer } = await generatePemSigner();
  const commonName = deviceCommonName(serialNumber, deviceId, client);
  const csrPem = await buildCsr(signer, commonName);
  return { privateKeyPem, publicKeyPem, csrPem, commonName };
}
