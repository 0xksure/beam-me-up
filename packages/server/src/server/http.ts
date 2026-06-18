/**
 * Streamable HTTP entrypoint.
 *
 * Two ways to consume Beam Me Up: download + run it as a local stdio MCP, or
 * call this HTTP transport ("the MCP API"). Because the HTTP transport can drive
 * real deploys/provisioning, it is hardened to be safe by default:
 *
 *   - Binds to 127.0.0.1 by default (override with BEAM_HTTP_HOST). It does NOT
 *     listen on all interfaces unless you ask it to.
 *   - OAuth 2.0 Resource Server: when OAuth is configured (src/auth/oauth/config.ts
 *     — OAUTH_ISSUER + OAUTH_AUDIENCE + a key), every `/mcp` request must carry a
 *     valid `Authorization: Bearer <token>`; a missing/invalid token gets a 401
 *     (or 403 for insufficient scope) with `WWW-Authenticate: Bearer
 *     resource_metadata="…"`, and RFC 9728 metadata is published at
 *     `/.well-known/oauth-protected-resource`.
 *   - startBeamHttpServer REFUSES to listen on a non-loopback host without OAuth
 *     (set BEAM_HTTP_ALLOW_INSECURE=1 to override for trusted private networks).
 *   - DNS-rebinding protection: the `/mcp` endpoint validates the Host header
 *     (loopback or BEAM_HTTP_ALLOWED_HOSTS) and, when present, the Origin header
 *     (loopback or BEAM_HTTP_ALLOWED_ORIGINS), so a browser page on another site
 *     can't drive a locally-running server.
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
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createServer } from "../mcp/server.js";
import { resolveOAuthGuard } from "../auth/oauth/guard.js";

const PORT = Number(process.env.PORT ?? 3000);
/** Default to loopback so the API is not exposed unless the operator opts in. */
const HOST = process.env.BEAM_HTTP_HOST ?? "127.0.0.1";
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

/* ------------------------------------------------------------------ */
/* Host / Origin allowlist (DNS-rebinding protection)                  */
/* ------------------------------------------------------------------ */

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "localhost";
}

function parseList(envVal: string | undefined): string[] {
  return (envVal ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Hostname portion of a Host header (strips the port; handles IPv6 [..]). */
function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const h = hostHeader.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1).toLowerCase() : h.toLowerCase();
  }
  return (h.split(":")[0] ?? "").toLowerCase();
}

/**
 * Guard against DNS-rebinding: a request is allowed when its Host is loopback
 * or explicitly allowlisted, and (if it carries an Origin — browsers always do,
 * non-browser MCP clients don't) the Origin is loopback or allowlisted.
 */
function checkOriginGuard(req: IncomingMessage): { ok: true } | { ok: false; reason: string } {
  const allowedHosts = parseList(process.env.BEAM_HTTP_ALLOWED_HOSTS);
  const allowedOrigins = parseList(process.env.BEAM_HTTP_ALLOWED_ORIGINS);

  // Fail closed on a missing/blank Host: a legitimate HTTP/1.1 client always
  // sends a real Host, so an empty one is treated as untrusted.
  const rawHost = (req.headers.host ?? "").toLowerCase();
  const hostName = hostnameOf(req.headers.host);
  const hostOk =
    isLoopbackHostname(hostName) ||
    allowedHosts.includes(hostName) ||
    allowedHosts.includes(rawHost);
  if (!hostOk) return { ok: false, reason: `Host "${req.headers.host}" is not allowed` };

  // Origin is validated independently of the Host allowlist (different trust
  // decision): loopback, or an exact match in BEAM_HTTP_ALLOWED_ORIGINS.
  const origin = (req.headers.origin ?? "").toString();
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return { ok: false, reason: "malformed Origin header" };
    }
    const originOk =
      isLoopbackHostname(originHost) || allowedOrigins.includes(origin.toLowerCase());
    if (!originOk) return { ok: false, reason: `Origin "${origin}" is not allowed` };
  }
  return { ok: true };
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

    // DNS-rebinding protection: reject foreign Host/Origin before any work.
    const originGuard = checkOriginGuard(req);
    if (!originGuard.ok) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden", detail: originGuard.reason }));
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

      // M9 P1 — IDENTITY SEAM: stop discarding the verified claims. Carry the
      // authenticated subject through the SDK's per-request channel by setting
      // req.auth to an SDK-shaped AuthInfo BEFORE transport.handleRequest, so it
      // surfaces to tool handlers as extra.authInfo. The SDK AuthInfo has no
      // `subject` field, so the JWT sub rides in authInfo.extra.subject.
      //
      // NOTE: we deliberately do NOT yet build a resolving CredentialContext or
      // pass one into createServer() — the per-user vault is P2. Production
      // behaviour is unchanged: createServer() runs with no ctx, so credentials
      // still resolve from process.env.
      const rawHeader = req.headers.authorization?.trim() ?? "";
      const bearer = rawHeader.slice(7).trim();
      const authInfo: AuthInfo = {
        token: bearer,
        clientId: result.auth.clientId ?? "",
        scopes: result.auth.scopes,
        expiresAt: result.auth.expiresAt,
        extra: {
          subject: result.auth.subject,
          claims: result.auth.claims,
        },
      };
      (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
    }

    try {
      const body = await readBody(req);

      // Stateless: a fresh MCP server + transport per request. createServer() is
      // called with NO ctx (the credential vault is P2); env creds are used.
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

/**
 * Start listening and log the mode. Binds HOST (loopback by default). REFUSES to
 * expose a no-auth server on a non-loopback host unless BEAM_HTTP_ALLOW_INSECURE
 * is set — exposing the deploy/provision tools unauthenticated is a footgun.
 */
export function startBeamHttpServer(port: number = PORT, host: string = HOST): Server {
  const authed = resolveOAuthGuard() !== null;
  const loopback = isLoopbackHostname(host) || isLoopbackHostname(hostnameOf(host));
  const allowInsecure = /^(1|true|yes|on)$/i.test(
    process.env.BEAM_HTTP_ALLOW_INSECURE ?? "",
  );

  if (!loopback && !authed && !allowInsecure) {
    const msg =
      `[beam-me-up] REFUSING to start: binding ${host}:${port} exposes the MCP ` +
      `API on a non-loopback interface with NO authentication. Configure OAuth ` +
      `(OAUTH_ISSUER + OAUTH_AUDIENCE + OAUTH_JWT_SECRET|OAUTH_JWT_PUBLIC_KEY), ` +
      `bind to 127.0.0.1 (unset BEAM_HTTP_HOST), or set BEAM_HTTP_ALLOW_INSECURE=1 ` +
      `if this is a trusted private network.\n`;
    process.stderr.write(msg);
    throw new Error("refusing to start an unauthenticated HTTP server on a public interface");
  }

  const server = createBeamHttpServer();
  server.listen(port, host, () => {
    const mode = authed
      ? "OAuth bearer auth"
      : loopback
        ? "no auth, loopback only"
        : "no auth, INSECURE (exposed) — explicitly allowed";
    process.stderr.write(
      `[beam-me-up] HTTP (${mode}) listening on http://${host}:${port}${MCP_PATH}\n`,
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
