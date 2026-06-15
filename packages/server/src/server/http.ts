/**
 * Streamable HTTP entrypoint.
 *
 * M5: OAuth is now supported on this transport so it is safe to run off
 * localhost. The Beam Me Up server acts as an OAuth 2.0 *Resource Server*:
 *
 *   - When OAuth is configured (see src/auth/oauth/config.ts — OAUTH_ISSUER +
 *     OAUTH_AUDIENCE + a key), every request to `/mcp` must carry a valid
 *     `Authorization: Bearer <token>`. A missing/invalid token gets a 401 (or
 *     403 for insufficient scope) with a `WWW-Authenticate: Bearer
 *     resource_metadata="…"` header, and the server publishes RFC 9728 protected
 *     resource metadata at `/.well-known/oauth-protected-resource`.
 *   - When OAuth is NOT configured, the server keeps its original no-auth
 *     localhost behavior (with a startup warning) for local development.
 *
 * We run in stateless mode (sessionIdGenerator: undefined): a fresh server +
 * transport per request. This keeps the server dependency-free (no Express,
 * just the Node http module + node:crypto for token verification).
 *
 * createBeamHttpServer() returns the http.Server WITHOUT listening so tests can
 * bind it to an ephemeral port; the file only auto-listens when run as the
 * entrypoint.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "../mcp/server.js";
import { resolveOAuthGuard } from "../auth/oauth/guard.js";

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

/**
 * Build the Beam Me Up HTTP server (not yet listening). The OAuth guard is
 * resolved from the environment HERE, so callers/tests set env before calling.
 */
export function createBeamHttpServer(): Server {
  // null when OAuth is disabled (no-auth localhost mode).
  const guard = resolveOAuthGuard();

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    // OAuth protected-resource metadata (RFC 9728), only when auth is enabled.
    if (guard && req.method === "GET" && url.pathname === guard.metadataPath) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(guard.metadata));
      return;
    }

    // Only the MCP endpoint is served.
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found", hint: `use ${MCP_PATH}` }));
      return;
    }

    // Bearer-token auth when OAuth is enabled. A failure short-circuits before
    // we ever touch the MCP server.
    if (guard) {
      const result = await guard.authorize(req.headers.authorization);
      if (!result.ok) {
        res.writeHead(result.status, {
          "Content-Type": "application/json",
          "WWW-Authenticate": result.wwwAuthenticate,
        });
        res.end(JSON.stringify(result.body));
        return;
      }
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
}

/** Start listening on PORT and log the mode (auth vs no-auth). */
export function startBeamHttpServer(port: number = PORT): Server {
  const server = createBeamHttpServer();
  const authed = resolveOAuthGuard() !== null;
  server.listen(port, () => {
    const mode = authed
      ? "OAuth bearer auth"
      : "no auth, dev only — do NOT expose this port publicly";
    process.stderr.write(
      `[beam-me-up] HTTP (${mode}) listening on http://localhost:${port}${MCP_PATH}\n`,
    );
  });
  return server;
}

// Auto-listen only when run as the entrypoint (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  startBeamHttpServer();
}
