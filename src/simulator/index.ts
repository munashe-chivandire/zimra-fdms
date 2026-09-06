/**
 * zimra-fdms/simulator: a local FDMS for development and CI. Node only.
 *
 *   const sim = await FdmsSimulator.create();
 *   const { url, caPem } = await sim.start();
 *   const device = new FiscalDevice(identity, { certificatePem, privateKeyPem }, { baseUrl: url, ca: caPem });
 */
export { FdmsSimulator, type SimulatorOptions, type Faults, type SimDevice, type SimDay, type SimReceipt } from "./server.js";
export { SimulatorCa } from "./ca.js";
