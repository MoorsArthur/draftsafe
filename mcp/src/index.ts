#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// draftsafe-mcp: stdio MCP server for Thunderbird via the Draftsafe add-on.
// It never sends mail: no such tool exists here and no such endpoint exists
// in the add-on's bridge.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge-client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer(new BridgeClient());
  await server.connect(new StdioServerTransport());
}

main().catch(err => {
  console.error("draftsafe-mcp failed to start:", err);
  process.exit(1);
});
