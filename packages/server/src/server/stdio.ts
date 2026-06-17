/**
 * stdio entrypoint - the standard way to connect Beam Me Up to Claude Code /
 * Cursor:
 *
 *   claude mcp add beam-me-up -- npx tsx \
 *     /ABSOLUTE/PATH/TO/beam-me-up/packages/server/src/server/stdio.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "../mcp/server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: do not write to stdout here - stdout is the JSON-RPC channel.
  // Diagnostics go to stderr.
  process.stderr.write("[beam-me-up] stdio server connected\n");
}

main().catch((err) => {
  process.stderr.write(`[beam-me-up] fatal: ${String(err)}\n`);
  process.exit(1);
});
