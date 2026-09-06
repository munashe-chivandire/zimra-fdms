/**
 * Profile directory handling shared by the CLI and the MCP server.
 *
 * A profile directory (default ./.zimra, override via ZIMRA_PROFILE) holds:
 *
 *   device.json              device identity + environment
 *   device-certificate.pem   mTLS certificate issued by FDMS
 *   device-private-key.pem   matching private key (never leaves this machine)
 *   day-state.json           open fiscal day: counters, hash chain, receipt nos
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { FiscalDayState } from "../core/device.js";
import { FdmsClient } from "../core/transport.js";
import { signCanonicalString } from "../core/signer.js";
import { FiscalDevice } from "./device.js";
import { PemSigner } from "./pem-signer.js";
import { NodeTransport } from "./transport.js";
import {
  fiscalDaySigningString,
  toCents,
} from "../core/signing.js";
import type {
  DeviceIdentity,
  FdmsEnvironment,
  GetStatusResponse,
} from "../core/types.js";

/** A problem with the profile itself (missing files, mismatched device, ...). */
export class ProfileError extends Error {}

export interface Profile {
  dir: string;
  device: DeviceIdentity & { environment: FdmsEnvironment };
  certificatePem: string;
  privateKeyPem: string;
}

export function profileDir(flag?: string): string {
  return resolve(flag ?? process.env.ZIMRA_PROFILE ?? ".zimra");
}

export function loadProfile(flag?: string): Profile {
  const dir = profileDir(flag);
  const devicePath = join(dir, "device.json");
  if (!existsSync(devicePath)) {
    throw new ProfileError(
      `No device profile at ${devicePath}.\n` +
        `Run \`zimra-fdms register\` first, or point --profile (or ZIMRA_PROFILE) at an existing profile directory.`,
    );
  }
  const device = JSON.parse(readFileSync(devicePath, "utf-8"));
  for (const k of ["deviceId", "serialNumber", "modelName", "modelVersion", "environment"]) {
    if (device[k] === undefined) {
      throw new ProfileError(`${devicePath} is missing "${k}".`);
    }
  }
  return {
    dir,
    device,
    certificatePem: readProfileFile(dir, "device-certificate.pem"),
    privateKeyPem: readProfileFile(dir, "device-private-key.pem"),
  };
}

function readProfileFile(dir: string, name: string): string {
  const p = join(dir, name);
  if (!existsSync(p)) {
    throw new ProfileError(
      `Missing ${p} — the profile is incomplete. Re-run \`zimra-fdms register\`.`,
    );
  }
  return readFileSync(p, "utf-8");
}

/** Persists a freshly registered device to the profile directory. */
export function writeProfile(
  dir: string,
  device: DeviceIdentity & { environment: FdmsEnvironment },
  certificatePem: string,
  privateKeyPem: string,
): { keyPath: string } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "device.json"), `${JSON.stringify(device, null, 2)}\n`);
  writeFileSync(join(dir, "device-certificate.pem"), certificatePem);
  const keyPath = join(dir, "device-private-key.pem");
  writeFileSync(keyPath, privateKeyPem);
  try {
    chmodSync(keyPath, 0o600); // no-op on Windows, meaningful elsewhere
  } catch {
    /* best effort */
  }
  return { keyPath };
}

/**
 * ZIMRA_BASE_URL and ZIMRA_CA point the CLI and MCP server at a local
 * simulator instead of the environment in device.json.
 */
export function endpointOverrides(): { baseUrl?: string; ca?: string } {
  const baseUrl = process.env.ZIMRA_BASE_URL || undefined;
  const caPath = process.env.ZIMRA_CA;
  return { baseUrl, ca: caPath ? readFileSync(caPath, "utf-8") : undefined };
}

export function fiscalDeviceFrom(p: Profile): FiscalDevice {
  return new FiscalDevice(
    p.device,
    { certificatePem: p.certificatePem, privateKeyPem: p.privateKeyPem },
    { environment: p.device.environment, stateDir: p.dir, ...endpointOverrides() },
  );
}

// -- day state --------------------------------------------------------------

interface PersistedDayState {
  deviceId: number;
  savedAt: string;
  state: FiscalDayState;
}

export function dayStatePath(dir: string): string {
  return join(dir, "day-state.json");
}

export function loadDayState(p: Profile): FiscalDayState | undefined {
  const path = dayStatePath(p.dir);
  if (!existsSync(path)) return undefined;
  const persisted: PersistedDayState = JSON.parse(readFileSync(path, "utf-8"));
  if (persisted.deviceId !== p.device.deviceId) {
    throw new ProfileError(
      `${path} belongs to device ${persisted.deviceId}, but this profile is device ${p.device.deviceId}. Delete the stale file to continue.`,
    );
  }
  return persisted.state;
}

export function saveDayState(p: Profile, state: FiscalDayState): void {
  const persisted: PersistedDayState = {
    deviceId: p.device.deviceId,
    savedAt: new Date().toISOString(),
    state,
  };
  writeFileSync(dayStatePath(p.dir), `${JSON.stringify(persisted, null, 2)}\n`);
  saveLastGlobalNo(p, state.receiptGlobalNo);
}

export function clearDayState(p: Profile): void {
  rmSync(dayStatePath(p.dir), { force: true });
}

/**
 * Highest receipt global number this profile has issued, kept across days.
 * FDMS's GetStatus reports the number of the receipt with the latest
 * receiptDate, so after a future-dated receipt it lags the real maximum and
 * the next day's first receipt would get a Red RCPT012.
 */
export function lastGlobalNoPath(dir: string): string {
  return join(dir, "last-receipt-global-no.json");
}

export function loadLastGlobalNo(p: Profile): number | undefined {
  const path = lastGlobalNoPath(p.dir);
  if (!existsSync(path)) return undefined;
  const v = JSON.parse(readFileSync(path, "utf-8"));
  return v.deviceId === p.device.deviceId ? v.lastReceiptGlobalNo : undefined;
}

export function saveLastGlobalNo(p: Profile, lastReceiptGlobalNo: number): void {
  const prev = loadLastGlobalNo(p) ?? 0;
  if (lastReceiptGlobalNo <= prev) return;
  writeFileSync(
    lastGlobalNoPath(p.dir),
    `${JSON.stringify({ deviceId: p.device.deviceId, lastReceiptGlobalNo }, null, 2)}\n`,
  );
}

// -- day close helpers ------------------------------------------------------

export interface ServerCountersClose {
  alreadyClosed: boolean;
  fiscalDayNo?: number;
  counterCount?: number;
  receiptCounter?: number;
  /** Date used in the CloseDay signature. */
  fiscalDayDate?: string;
  /** True when no date was given and today was assumed. */
  assumedToday?: boolean;
}

const FISCAL_DAY_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pick the fiscal-day date for a stateless close. FDMS signs CloseDay over
 * the date the day was *opened*, and GetStatus never reports it, so a day
 * opened yesterday cannot be closed without the caller supplying the date.
 */
export function resolveFiscalDayDate(explicit?: string): {
  fiscalDayDate: string;
  assumedToday: boolean;
} {
  if (explicit !== undefined) {
    if (!FISCAL_DAY_DATE.test(explicit) || Number.isNaN(Date.parse(explicit))) {
      throw new ProfileError(
        `Invalid fiscal day date "${explicit}" — expected YYYY-MM-DD (the date the day was opened).`,
      );
    }
    return { fiscalDayDate: explicit, assumedToday: false };
  }
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    fiscalDayDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    assumedToday: true,
  };
}

/**
 * Stateless close: sign whatever counters the server reports. This is the
 * recovery path for a lost/absent day-state.json and mirrors what the server
 * expects bit-for-bit, since the numbers are its own.
 */
export async function closeFromServerCounters(
  p: Profile,
  opts: { fiscalDayDate?: string } = {},
): Promise<ServerCountersClose> {
  const overrides = endpointOverrides();
  const http = new FdmsClient(
    p.device,
    new NodeTransport({ certificatePem: p.certificatePem, privateKeyPem: p.privateKeyPem }, { ca: overrides.ca }),
    { environment: p.device.environment, baseUrl: overrides.baseUrl },
  );
  const status = await http.request<GetStatusResponse>(
    "GET",
    http.devicePath("GetStatus"),
  );
  if (status.fiscalDayStatus === "FiscalDayClosed") {
    return { alreadyClosed: true };
  }
  const fiscalDayNo = status.lastFiscalDayNo;
  if (fiscalDayNo == null) {
    throw new ProfileError("Server did not report a fiscal day number.");
  }

  const counters = (status.fiscalDayCounter ?? []).filter(
    (c) => toCents(c.fiscalCounterValue) !== 0,
  );
  const receiptCounter = (status.fiscalDayDocumentQuantities ?? []).reduce(
    (sum, q) => sum + (q.receiptQuantity ?? 0),
    0,
  );
  // GetStatus doesn't report when the day was opened, but the signature is
  // over that date. Callers recovering a day from a previous date must pass it.
  const { fiscalDayDate, assumedToday } = resolveFiscalDayDate(opts.fiscalDayDate);

  const canonical = fiscalDaySigningString(
    p.device.deviceId,
    fiscalDayNo,
    fiscalDayDate,
    counters,
  );
  const signature = await signCanonicalString(new PemSigner(p.privateKeyPem), canonical, "der");
  await http.request("POST", http.devicePath("CloseDay"), {
    fiscalDayNo,
    fiscalDayCounters: counters,
    fiscalDayDeviceSignature: signature,
    receiptCounter,
  });
  return {
    alreadyClosed: false,
    fiscalDayNo,
    counterCount: counters.length,
    receiptCounter,
    fiscalDayDate,
    assumedToday,
  };
}

/** CloseDay is asynchronous server-side; poll until it settles. */
export async function pollDayClosed(
  p: Profile,
  onTick?: () => void,
): Promise<string> {
  const device = fiscalDeviceFrom(p);
  let last = "FiscalDayCloseInitiated";
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await device.getStatus();
    last = s.fiscalDayStatus;
    if (last === "FiscalDayClosed" || last === "FiscalDayCloseFailed") break;
    onTick?.();
  }
  return last;
}
