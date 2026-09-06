import {
  FiscalDevice as CoreFiscalDevice,
  type FiscalDeviceDeps,
  type FiscalDeviceOptions,
} from "../core/device.js";
import type { DeviceIdentity } from "../core/types.js";
import { generateDeviceCsr, type DeviceKeyPair } from "./keys.js";
import { PemSigner } from "./pem-signer.js";
import { NodeTransport, type MtlsIdentity, type NodeTransportOptions } from "./transport.js";
import { FileStorage } from "./storage.js";

export type NodeFiscalDeviceOptions = FiscalDeviceOptions &
  NodeTransportOptions & {
    /**
     * Directory for day state and the pending-submit marker. Files are
     * `day-state.json`, `pending-submit.json` and
     * `last-receipt-global-no.json`; a CLI profile directory works.
     */
    stateDir?: string;
  };

/**
 * FiscalDevice for Node. Accepts the 0.3.x PEM identity and builds the
 * PemSigner and keep-alive mTLS transport from it, or takes core deps directly.
 */
export class FiscalDevice extends CoreFiscalDevice {
  constructor(
    device: DeviceIdentity,
    identity: MtlsIdentity | FiscalDeviceDeps,
    options: NodeFiscalDeviceOptions = {},
  ) {
    const deps = "privateKeyPem" in identity ? depsFromPem(identity, options) : identity;
    if (options.stateDir && !deps.storage) deps.storage = new FileStorage(options.stateDir);
    super(device, deps, options);
  }

  /**
   * Node keeps the 0.3.x behaviour: a fresh exportable key pair per renewal,
   * returned as PEM for the caller to persist. To renew a hardware key with
   * its existing pair, use the core FiscalDevice.
   */
  async renewWithNewKey(): Promise<{
    keys: DeviceKeyPair;
    certificatePem: string;
    operationId: string;
  }> {
    const keys = await generateDeviceCsr(this.device.serialNumber, this.device.deviceId);
    const res = await this.http.request<{ operationID: string; certificate: string }>(
      "POST",
      this.http.devicePath("IssueCertificate"),
      { certificateRequest: keys.csrPem },
    );
    return { keys, certificatePem: res.certificate, operationId: res.operationID };
  }
}

function depsFromPem(identity: MtlsIdentity, options: NodeTransportOptions): FiscalDeviceDeps {
  return {
    signer: new PemSigner(identity.privateKeyPem),
    transport: new NodeTransport(identity, options),
  };
}
