/**
 * Live MCP E2E against FDMS TEST, device 37367: spawns the real
 * `node dist/cli.js mcp` process and drives it with the v2 client over stdio.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/cli.js", "mcp", "--profile", ".zimra"],
});
const client = new Client(
  { name: "live-e2e", version: "0.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
await client.connect(transport);
console.log(
  `connected — era: ${client.getProtocolEra()}, protocol: ${client.getNegotiatedProtocolVersion()}`,
);

async function call(name, args = {}, timeout = 120_000) {
  const res = await client.callTool({ name, arguments: args }, { timeout });
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  console.log(`\n== ${name} ==\n${text}`);
  return res.structuredContent ?? {};
}

try {
  await call("ping");
  const config = await call("get_config");
  let status = await call("get_status");

  if (status.fiscalDayStatus !== "FiscalDayClosed") {
    console.log(`\nDay is ${status.fiscalDayStatus} — closing it first (recovery path)...`);
    await call("close_fiscal_day");
  }

  const open = await call("open_fiscal_day");

  const standard =
    config.applicableTaxes.find((t) => (t.taxPercent ?? 0) > 0) ??
    config.applicableTaxes[0];
  const runId = Date.now().toString(36).toUpperCase();
  const line = (name, price, qty) => ({
    name,
    price,
    quantity: qty,
    taxId: standard.taxID,
    taxPercent: standard.taxPercent,
    taxCode: standard.taxCode ?? undefined,
  });

  const r1 = await call("submit_receipt", {
    receipt: {
      currency: "USD",
      invoiceNo: `MCP-${runId}-1`,
      linesTaxInclusive: true,
      lines: [line("Bread", 2.5, 2)],
      payments: [{ moneyType: "Cash", amount: 5.0 }],
    },
  });
  const r2 = await call("submit_receipt", {
    receipt: {
      currency: "USD",
      invoiceNo: `MCP-${runId}-2`,
      linesTaxInclusive: true,
      lines: [line("Milk", 1.75, 4)],
      payments: [{ moneyType: "Card", amount: 7.0 }],
    },
  });
  if (r2.receiptCounter !== r1.receiptCounter + 1) {
    throw new Error("receipt counters did not chain");
  }
  for (const [i, r] of [r1, r2].entries()) {
    if ((r.validationErrors ?? []).length) {
      throw new Error(`receipt ${i + 1} has validation errors: ${JSON.stringify(r.validationErrors)}`);
    }
  }

  await call("close_fiscal_day", {}, 180_000);
  status = await call("get_status");

  console.log(
    `\nRESULT: day ${open.fiscalDayNo} opened, 2 receipts chained (global ${r1.receiptGlobalNo} -> ${r2.receiptGlobalNo}), day now ${status.fiscalDayStatus}.`,
  );
} finally {
  await client.close();
}
