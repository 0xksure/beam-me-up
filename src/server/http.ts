/**
 * Streamable HTTP entrypoint - local dev only.
 *
 * M0: NO AUTH. This server is meant to run on localhost for development and to
 * let you point an MCP client at it over HTTP.
 *
 * TODO(M1): Add OAuth to this transport. The Streamable HTTP transport is the
 * surface that needs protecting once Beam Me Up is reachable off-localhost -
 * OAuth (authorization server metadata + bearer-token verification on each
 * request, via the SDK's auth middleware) lands in M1. Until then, do NOT
 * expose this port publicly.
 *
 * We run in stateless mode (sessionIdGenerator: undefined): a fresh server +
 * transport per request. This keeps M0 dependency-free (no Express, just the
 * Node http module) and is fine for local single-user dev.
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "../mcp/server.js";

const PORT = Number(process.env.PORT ?? 3000);
const MCP_PATH = "/mcp";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const httpServer = createHttpServer(async (req, res) => {
  // Only the MCP endpoint is served.
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", hint: `use ${MCP_PATH}` }));
    return;
  }

  try {
    const body = await readBody(req);

    // Stateless: a fresh MCP server + transport per request.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    process.stderr.write(`[beam-me-up] http error: ${String(err)}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
});

httpServer.listen(PORT, () => {
  // Touch randomUUID so the import is used even in stateless mode; it is the
  // session-id generator you would swap in for a stateful M1 deployment.
  void randomUUID;
  process.stderr.write(
    `[beam-me-up] HTTP (no auth, dev only) listening on http://localhost:${PORT}${MCP_PATH}\n`,
  );
});
