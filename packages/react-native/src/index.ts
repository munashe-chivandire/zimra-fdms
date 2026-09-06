/**
 * @zimra-fdms/react-native: the Android adapter.
 *
 * The device key is generated inside Android Keystore (StrongBox when the
 * phone has it) and never leaves it. The native module signs, exports the
 * public key, and runs mutual TLS through OkHttp with a KeyManager bound to
 * that same key. Everything fiscal, including SHA-256 and MD5, runs in the
 * portable core on Hermes with no polyfills.
 */
import { NativeModules, Platform } from "react-native";
import {
  FiscalDevice,
  TransportError,
  fromBase64,
  toBase64,
  registerDevice as registerWithSigner,
  type DeviceIdentity,
  type FiscalDeviceOptions,
  type RegisterDeviceOptions,
  type RegisteredDevice,
  type Signer,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "zimra-fdms/core";

interface NativeZimraFdms {
  generateKey(alias: string, requireStrongBox: boolean): Promise<{ strongBox: boolean }>;
  hasKey(alias: string): Promise<boolean>;
  deleteKey(alias: string): Promise<void>;
  /** DER ECDSA signature over SHA-256 of the base64-decoded input, base64. */
  sign(alias: string, dataBase64: string): Promise<string>;
  /** DER SubjectPublicKeyInfo, base64. */
  publicKeySpki(alias: string): Promise<string>;
  /** PEM attestation chain, root last. Empty when the device cannot attest. */
  attestationChain(alias: string): Promise<string[]>;
  request(
    alias: string | null,
    certificatePem: string | null,
    req: { method: string; url: string; headers: Record<string, string>; body: string | null; timeoutMs: number },
  ): Promise<{ status: number; headers: Record<string, string>; text: string }>;
}

function native(): NativeZimraFdms {
  const mod = NativeModules.ZimraFdms as NativeZimraFdms | undefined;
  if (!mod) {
    throw new Error(
      Platform.OS === "android"
        ? "ZimraFdms native module not linked; rebuild the app after installing @zimra-fdms/react-native"
        : `@zimra-fdms/react-native supports Android only (got ${Platform.OS})`,
    );
  }
  return mod;
}

export interface KeystoreSignerOptions {
  /**
   * Refuse to create the key unless StrongBox (a separate secure element)
   * is available. Default false: StrongBox is used when present and the
   * TEE-backed keystore otherwise.
   */
  requireStrongBox?: boolean;
}

/** Signer over an ECDSA P-256 key in Android Keystore. */
export class KeystoreSigner implements Signer {
  constructor(readonly alias: string) {}

  /** Create the key if it does not exist. Safe to call on every launch. */
  static async ensure(alias: string, options: KeystoreSignerOptions = {}): Promise<KeystoreSigner> {
    const n = native();
    if (!(await n.hasKey(alias))) {
      await n.generateKey(alias, options.requireStrongBox ?? false);
    }
    return new KeystoreSigner(alias);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return fromBase64(await native().sign(this.alias, toBase64(data)));
  }

  async publicKeySpki(): Promise<Uint8Array> {
    return fromBase64(await native().publicKeySpki(this.alias));
  }

  /**
   * Key attestation certificate chain, for a bank or auditor to verify the
   * key is hardware-backed. See Android's key attestation docs for parsing.
   */
  attestationChain(): Promise<string[]> {
    return native().attestationChain(this.alias);
  }

  delete(): Promise<void> {
    return native().deleteKey(this.alias);
  }
}

/**
 * Transport over OkHttp. With an alias and certificate it presents that
 * keystore key as the TLS client identity; without them it is a plain
 * client for the Public endpoints.
 */
export class OkHttpTransport implements Transport {
  constructor(
    private readonly identity?: { alias: string; certificatePem: string },
  ) {}

  async request(req: TransportRequest): Promise<TransportResponse> {
    try {
      return await native().request(this.identity?.alias ?? null, this.identity?.certificatePem ?? null, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body ?? null,
        timeoutMs: req.timeoutMs,
      });
    } catch (err) {
      // The native side rejects with code "NETWORK" for connect, DNS and
      // timeout failures and "HTTP" for anything the server answered.
      const e = err as { code?: string; message?: string };
      if (e.code === "NETWORK") throw new TransportError(e.message ?? "network error", err);
      throw err;
    }
  }
}

/**
 * Register a device with a key that lives in the keystore. Returns the
 * certificate to persist; the key stays where it is.
 */
export async function registerDevice(
  device: DeviceIdentity,
  activationKey: string,
  signer: KeystoreSigner,
  options: RegisterDeviceOptions = {},
): Promise<RegisteredDevice> {
  return registerWithSigner(device, activationKey, signer, {
    ...options,
    transport: options.transport ?? new OkHttpTransport(),
  });
}

/** FiscalDevice wired to the keystore key and OkHttp. */
export function createFiscalDevice(
  device: DeviceIdentity,
  identity: { alias: string; certificatePem: string },
  options: FiscalDeviceOptions = {},
): FiscalDevice {
  return new FiscalDevice(
    device,
    { signer: new KeystoreSigner(identity.alias), transport: new OkHttpTransport(identity) },
    options,
  );
}

export * from "zimra-fdms/core";
