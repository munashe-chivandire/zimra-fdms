/**
 * MCP server tests — drive the compiled server (dist/mcp.js) over an in-memory
 * transport pair with the official v2 client. Everything here is offline:
 * tools that would touch FDMS are only exercised up to their local validation
 * (missing profile, missing day state).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createZimraMcpServer } from "../dist/mcp.js";

async function connected(profile?: string) {
  const server = createZimraMcpServer(profile);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

test("negotiates the modern 2026-07-28 protocol through the stdio entry", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createZimraMcpServer(), { transport: serverTransport });
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(clientTransport);
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    const res = (await client.callTool({ name: "sample_receipt", arguments: {} })) as {
      structuredContent?: { receipt?: { currency?: string } };
    };
    assert.equal(res.structuredContent?.receipt?.currency, "USD");
  } finally {
    await client.close();
    await handle.close();
  }
});

test("serves 2025-era clients from the same factory", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createZimraMcpServer(), { transport: serverTransport });
  const client = new Client({ name: "legacy-client", version: "0.0.0" });
  try {
    await client.connect(clientTransport);
    assert.equal(client.getProtocolEra(), "legacy");
    const { tools } = await client.listTools();
    assert.equal(tools.length, 8);
  } finally {
    await client.close();
    await handle.close();
  }
});

test("lists the full fiscalisation toolset", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "close_fiscal_day",
      "get_config",
      "get_status",
      "open_fiscal_day",
      "ping",
      "register_device",
      "sample_receipt",
      "submit_receipt",
    ]);
    const status = tools.find((t) => t.name === "get_status")!;
    assert.equal(status.annotations?.readOnlyHint, true);
    const register = tools.find((t) => t.name === "register_device")!;
    assert.equal(register.annotations?.destructiveHint, true);
    assert.ok(register.inputSchema.properties?.activationKey);
  } finally {
    await close();
  }
});

test("sample_receipt returns a usable template", async () => {
  const { client, close } = await connected();
  try {
    const res = (await client.callTool({ name: "sample_receipt", arguments: {} })) as {
      structuredContent?: { receipt?: { currency?: string; lines?: unknown[] } };
      isError?: boolean;
    };
    assert.ok(!res.isError);
    assert.equal(res.structuredContent?.receipt?.currency, "USD");
    assert.equal(res.structuredContent?.receipt?.lines?.length, 1);
  } finally {
    await close();
  }
});

test("tools fail in-band when the profile is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zimra-mcp-"));
  const missing = join(dir, "no-such-profile");
  const { client, close } = await connected(missing);
  try {
    const res = (await client.callTool({ name: "get_status", arguments: {} })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No device profile/);

    // Explicit per-call profile beats the server default (self-describing calls).
    const res2 = (await client.callTool({
      name: "submit_receipt",
      arguments: {
        profile: missing,
        receipt: {
          currency: "USD",
          invoiceNo: "INV-1",
          lines: [{ name: "Bread", price: 1, quantity: 1, taxId: 1, taxPercent: 15 }],
          payments: [{ moneyType: "Cash", amount: 1 }],
        },
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };
    assert.equal(res2.isError, true);
    assert.match(res2.content[0].text, /No device profile/);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});
