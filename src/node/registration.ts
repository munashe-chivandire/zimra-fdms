import {
  registerDevice as registerWithSigner,
  type RegisterDeviceOptions,
  type RegisteredDevice as CoreRegisteredDevice,
} from "../core/registration.js";
import type { Signer } from "../core/signer.js";
import type { DeviceIdentity } from "../core/types.js";
import { generatePemSigner } from "./pem-signer.js";
import type { DeviceKeyPair } from "./keys.js";

export type { RegisterDeviceOptions };

export interface RegisteredDevice extends CoreRegisteredDevice {
  /** Exportable PEM keys, present when this call generated them. */
  keys: DeviceKeyPair;
}

/**
 * 0.3.x registration: generate an exportable P-256 key, register, return the
 * PEMs for the caller to store. Pass a Signer as the third argument to
 * register a key that already exists (the core signature).
 */
export async function registerDevice(
  device: DeviceIdentity,
  activationKey: string,
  options?: RegisterDeviceOptions,
): Promise<RegisteredDevice>;
export async function registerDevice(
  device: DeviceIdentity,
  activationKey: string,
  signer: Signer,
  options?: RegisterDeviceOptions,
): Promise<CoreRegisteredDevice>;
export async function registerDevice(
  device: DeviceIdentity,
  activationKey: string,
  signerOrOptions?: Signer | RegisterDeviceOptions,
  options: RegisterDeviceOptions = {},
): Promise<RegisteredDevice | CoreRegisteredDevice> {
  if (signerOrOptions && "sign" in signerOrOptions) {
    return registerWithSigner(device, activationKey, signerOrOptions, options);
  }
  const { privateKeyPem, publicKeyPem, signer } = await generatePemSigner();
  const res = await registerWithSigner(device, activationKey, signer, signerOrOptions ?? {});
  const keys: DeviceKeyPair = { privateKeyPem, publicKeyPem, csrPem: res.csrPem, commonName: res.commonName };
  return { ...res, keys };
}
