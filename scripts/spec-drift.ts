/**
 * Watches ZIMRA's live Swagger specs for changes that would break this SDK.
 *
 * ZIMRA publishes the FDMS OpenAPI specs unauthenticated, so we can diff the
 * live contract against the baseline in spec/ on a schedule and find out about
 * breaking changes before a user's receipts start failing.
 *
 * Comparison is on the API *contract* — paths, params, required flags, enum
 * values, maxLength — not on formatting, so whitespace and key-order churn
 * don't register as drift.
 *
 * Findings are split into two tiers, because test and production genuinely
 * disagree with each other (prod omits ProductsStock and the DeviceInformation
 * branch search, and drops the "Enum" suffix from schema names). Reporting all
 * of that as breakage would make the watcher useless noise:
 *
 *   BREAKING — touches an endpoint or type this SDK actually uses. Exit 1.
 *   INFO     — drift elsewhere in FDMS. Reported, but not a failure.
 *
 * Usage: npm run spec:drift [-- --update]
 *   --update rewrites spec/ from the test environment to accept current live
 *   state as the new baseline.
 */

import { readFileSync, writeFileSync } from "node:fs";

const SPECS = ["Device-v1", "User-v1", "Public-v1", "ProductsStock-v1"] as const;

const ENVIRONMENTS = {
  test: "https://fdmsapitest.zimra.co.zw",
  production: "https://fdmsapi.zimra.co.zw",
} as const;

/**
 * Operations src/ actually calls. Drift here breaks real users; drift anywhere
 * else in FDMS does not. Keep in sync with device.ts / registration.ts.
 */
const SDK_OPERATIONS = [
  "GetConfig",
  "GetStatus",
  "OpenDay",
  "CloseDay",
  "IssueCertificate",
  "SubmitReceipt",
  "Ping",
  "RegisterDevice",
  "VerifyTaxpayerInformation",
];

/**
 * Enum types mirrored as closed unions in src/types.ts. A value ZIMRA adds here
 * is a value the SDK's types don't admit, so these are breaking even though the
 * schema they live in may not be one we name directly.
 */
const SDK_ENUMS = [
  "ReceiptType",
  "ReceiptLineType",
  "MoneyType",
  "FiscalCounterType",
  "FiscalDayStatus",
  "DeviceOperatingMode",
  "TaxPayerBranchStatus",
];

type Surface = Map<string, string>;

/** Reduce a spec to comparable contract facts, ignoring formatting. */
function surface(spec: any): Surface {
  const out: Surface = new Map();
  const schemas = spec.components?.schemas ?? spec.definitions ?? {};

  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (typeof op !== "object" || op === null) continue;
      const key = `${method.toUpperCase()} ${path}`;
      out.set(`path:${key}`, "present");
      for (const p of op.parameters ?? []) {
        out.set(`param:${key}:${p.in}/${p.name}`, `required=${!!p.required}`);
      }
      for (const code of Object.keys(op.responses ?? {})) {
        out.set(`resp:${key}:${code}`, "present");
      }
    }
  }

  for (const [rawName, s] of Object.entries<any>(schemas)) {
    // ZIMRA renamed schemas between environments (MoneyTypeEnum -> MoneyType)
    // with identical values. Schema names never go on the wire, so compare
    // under the bare name and let pure renames cancel out.
    const name = rawName.replace(/Enum$/, "");
    out.set(`schema:${name}`, "present");
    if (s.enum) out.set(`enum:${name}`, [...s.enum].sort().join("|"));
    const required = new Set<string>(s.required ?? []);
    for (const [prop, def] of Object.entries<any>(s.properties ?? {})) {
      const bits = [`type=${def.type ?? def.$ref ?? "?"}`];
      if (required.has(prop)) bits.push("REQUIRED");
      if (def.enum) bits.push(`enum=[${[...def.enum].sort().join("|")}]`);
      if (def.maxLength != null) bits.push(`max=${def.maxLength}`);
      if (def.format) bits.push(`fmt=${def.format}`);
      out.set(`prop:${name}.${prop}`, bits.join(" "));
    }
  }
  return out;
}

/** True if this contract key is something the SDK depends on. */
function isBreaking(key: string): boolean {
  // Enum *values* changing under a type we mirror as a closed union breaks us.
  if (key.startsWith("enum:")) return SDK_ENUMS.includes(key.slice("enum:".length));
  // Bare schema presence is name-churn; what matters is props/enums, tracked above.
  if (key.startsWith("schema:")) return false;
  // Documented response codes don't change what we send; error handling is generic.
  if (key.startsWith("resp:")) return false;
  return SDK_OPERATIONS.some((op) => key.includes(`/${op}`));
}

async function fetchSpec(baseUrl: string, name: string): Promise<any> {
  const url = `${baseUrl}/swagger/${name}/swagger.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

interface Finding {
  kind: "removed" | "added" | "changed";
  key: string;
  was?: string;
  now?: string;
}

function diff(baseline: Surface, live: Surface): Finding[] {
  const findings: Finding[] = [];
  for (const [key, now] of live) {
    const was = baseline.get(key);
    if (was === undefined) findings.push({ kind: "added", key });
    else if (was !== now) findings.push({ kind: "changed", key, was, now });
  }
  for (const [key, was] of baseline) {
    if (!live.has(key)) findings.push({ kind: "removed", key, was });
  }
  return findings;
}

const SYMBOL = { removed: "-", added: "+", changed: "~" } as const;

function render(f: Finding): string {
  const line = `    ${SYMBOL[f.kind]} ${f.key}`;
  return f.kind === "changed" ? `${line}\n        was: ${f.was}\n        now: ${f.now}` : line;
}

async function main() {
  const update = process.argv.includes("--update");
  let breakingTotal = 0;
  let infoTotal = 0;
  const report: string[] = [];

  for (const name of SPECS) {
    const baselinePath = new URL(`../spec/${name}.json`, import.meta.url);

    if (update) {
      const live = await fetchSpec(ENVIRONMENTS.test, name);
      writeFileSync(baselinePath, `${JSON.stringify(live, null, 2)}\n`);
      console.log(`updated spec/${name}.json from test`);
      continue;
    }

    const baseline = surface(JSON.parse(readFileSync(baselinePath, "utf-8")));

    for (const [env, baseUrl] of Object.entries(ENVIRONMENTS)) {
      let live: Surface;
      try {
        live = surface(await fetchSpec(baseUrl, name));
      } catch (err) {
        // A fetch failure is a network problem, not a contract change. Say so
        // rather than reporting every endpoint as removed.
        report.push(`\n${name} [${env}]  UNREACHABLE — ${(err as Error).message}`);
        continue;
      }

      const findings = diff(baseline, live);
      const breaking = findings.filter((f) => isBreaking(f.key));
      const info = findings.filter((f) => !isBreaking(f.key));
      breakingTotal += breaking.length;
      infoTotal += info.length;

      const status = breaking.length ? `${breaking.length} BREAKING` : "ok";
      report.push(`\n${name} [${env}]  ${status}${info.length ? `, ${info.length} info` : ""}`);
      if (breaking.length) report.push("  BREAKING — SDK depends on these:", ...breaking.map(render));
      if (info.length) report.push("  info — elsewhere in FDMS:", ...info.map(render));
    }
  }

  if (update) return;

  console.log(report.join("\n"));
  console.log(`\n${"=".repeat(62)}`);
  console.log(`${breakingTotal} breaking, ${infoTotal} informational`);

  if (breakingTotal > 0) {
    console.log("\nZIMRA changed something this SDK relies on. Review before the next release.");
    process.exit(1);
  }
  console.log("\nNo drift on any contract the SDK depends on.");
}

await main();
