/**
 * m8.test.ts - tests for the M8 auth audit + Google sign-in scaffold + HTTP
 * hardening. PURE/offline: the unit checks are pure, the MCP checks use an
 * in-memory client, and the HTTP checks bind the real server to an ephemeral
 * loopback port. No network.
 *
 * Covers:
 *   [unit] detectAuth (login detection):
 *     - an Express + passport-google + express-session app -> loginImplemented,
 *       mechanisms include "passport"/"express-session", providers include
 *       "google", offerGoogleAuth false.
 *     - an Express app with a mutating route but NO auth -> loginImplemented
 *       false, mutatingRoutesPresent true, offerGoogleAuth true.
 *     - a NextAuth/Auth.js app -> mechanisms include "next-auth", providers
 *       include "google".
 *     - a static page (no server) -> loginImplemented false, offerGoogleAuth
 *       false (nothing to protect).
 *   [unit] detectSecrets: a Google OAuth client secret ("GOCSPX-…") is flagged
 *     high as "google-oauth-client-secret" -> GOOGLE_CLIENT_SECRET, masked (the
 *     raw value never appears in the finding).
 *   [tool] in-memory MCP client: listTools includes "scaffold_auth" (13 tools);
 *     preflight_scan surfaces auth.offerGoogleAuth on the no-login fixture;
 *     scaffold_auth returns a valid, framework-tailored scaffold for nextjs /
 *     express(internal) / generic.
 *   [http] createBeamHttpServer (no OAuth) rejects a foreign Origin with 403 but
 *     serves a loopback (no-Origin) request; startBeamHttpServer refuses to
 *     expose a no-auth server on 0.0.0.0 but binds loopback fine.
 *
 * Wired to `npm run test:m8` (tsx test/m8.test.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "@beam-me-up/server";
import { createBeamHttpServer, startBeamHttpServer } from "@beam-me-up/server";
import { detectAuth, detectSecrets } from "@beam-me-up/detect";
import { scaffoldAuth } from "@beam-me-up/tools";
import {
  PreflightScanOutputSchema,
  ScaffoldAuthOutputSchema,
  type PreflightFile,
} from "@beam-me-up/core";

/* ------------------------------------------------------------------ */
/* Tiny assertion harness with PASS/FAIL printing                      */
/* ------------------------------------------------------------------ */

let passCount = 0;
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    process.stdout.write(`  FAIL  ${msg}\n`);
    throw new Error(`assertion failed: ${msg}`);
  }
  passCount += 1;
  process.stdout.write(`  PASS  ${msg}\n`);
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first && first.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const APP_WITH_LOGIN: PreflightFile[] = [
  {
    path: "auth.js",
    content: `const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "/auth/google/callback",
}, function (a, r, profile, done) { return done(null, profile); }));
module.exports = passport;
`,
  },
  {
    path: "server.js",
    content: `const express = require("express");
const session = require("express-session");
const passport = require("./auth");
const app = express();
app.use(session({ secret: process.env.SESSION_SECRET }));
app.use(passport.initialize());
app.use(passport.session());
app.get("/auth/google", passport.authenticate("google", { scope: ["email"] }));
app.post("/api/items", function (req, res) { res.json({ ok: true }); });
app.listen(3000);
`,
  },
];

const APP_NO_LOGIN: PreflightFile[] = [
  {
    path: "server.js",
    content: `const express = require("express");
const app = express();
app.get("/", function (req, res) { res.send("hi"); });
app.post("/api/items", function (req, res) { res.json({ created: true }); });
app.delete("/api/items/:id", function (req, res) { res.json({ ok: true }); });
app.listen(3000);
`,
  },
];

const APP_NEXTAUTH: PreflightFile[] = [
  {
    path: "auth.ts",
    content: `import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
});
`,
  },
];

const STATIC_SITE: PreflightFile[] = [
  {
    path: "index.html",
    content: `<!doctype html><html><body><h1>Hello</h1>
<script>document.title = "hi";</script></body></html>`,
  },
];

/* ------------------------------------------------------------------ */
/* [unit] detectAuth                                                   */
/* ------------------------------------------------------------------ */

function testDetectAuth(): void {
  process.stdout.write("\n[unit] detectAuth login detection\n");

  const withLogin = detectAuth(APP_WITH_LOGIN);
  check(withLogin.loginImplemented === true, "app with passport+session -> loginImplemented true");
  check(
    withLogin.mechanisms.includes("passport") && withLogin.mechanisms.includes("express-session"),
    `mechanisms include passport + express-session (got ${JSON.stringify(withLogin.mechanisms)})`,
  );
  check(
    withLogin.providers.includes("google"),
    `providers include google (got ${JSON.stringify(withLogin.providers)})`,
  );
  check(withLogin.offerGoogleAuth === false, "login present -> offerGoogleAuth false");
  check(withLogin.confidence >= 0.7, `login-present confidence >= 0.7 (got ${withLogin.confidence})`);
  check(withLogin.signals.length > 0, "login-present yields supporting signals");

  const noLogin = detectAuth(APP_NO_LOGIN);
  check(noLogin.loginImplemented === false, "express app with no auth -> loginImplemented false");
  check(noLogin.mutatingRoutesPresent === true, "POST/DELETE routes -> mutatingRoutesPresent true");
  check(noLogin.offerGoogleAuth === true, "no login + serves requests -> offerGoogleAuth true");
  check(
    /scaffold_auth/.test(noLogin.recommendation),
    `no-login recommendation points at scaffold_auth (got ${JSON.stringify(noLogin.recommendation)})`,
  );

  const next = detectAuth(APP_NEXTAUTH);
  check(
    next.mechanisms.includes("next-auth"),
    `NextAuth app -> mechanisms include next-auth (got ${JSON.stringify(next.mechanisms)})`,
  );
  check(next.loginImplemented === true, "NextAuth app -> loginImplemented true");
  check(
    next.providers.includes("google"),
    `NextAuth Google import -> providers include google (got ${JSON.stringify(next.providers)})`,
  );

  const stat = detectAuth(STATIC_SITE);
  check(stat.loginImplemented === false, "static site -> loginImplemented false");
  check(
    stat.offerGoogleAuth === false,
    "static site (no server) -> offerGoogleAuth false (nothing to protect)",
  );

  check(detectAuth([]).loginImplemented === false, "detectAuth([]) does not throw; loginImplemented false");
}

/* ------------------------------------------------------------------ */
/* [unit] detectSecrets: Google OAuth client secret (GOCSPX-)          */
/* ------------------------------------------------------------------ */

function testClientSecret(): void {
  process.stdout.write("\n[unit] detectSecrets Google OAuth client secret\n");

  const RAW = "GOCSPX-abcdEFGH1234ijklMNOP5678";
  const findings = detectSecrets([
    { path: "config.js", content: `const clientSecret = "${RAW}";\n` },
  ]);
  const hit = findings.find((f) => f.kind === "google-oauth-client-secret");
  check(hit !== undefined, `GOCSPX- secret is detected as "google-oauth-client-secret" (got ${JSON.stringify(findings.map((f) => f.kind))})`);
  if (hit) {
    check(hit.severity === "high", "Google OAuth client secret is severity high");
    check(
      hit.suggestedEnvKey === "GOOGLE_CLIENT_SECRET",
      `suggestedEnvKey is GOOGLE_CLIENT_SECRET (got ${hit.suggestedEnvKey})`,
    );
    check(!hit.masked.includes(RAW), "the raw client secret is NOT echoed in masked");
  }
}

/* ------------------------------------------------------------------ */
/* [unit] scaffold_auth is injection-resistant                         */
/* ------------------------------------------------------------------ */

/** Write `contents` to a temp .js file and return whether `node --check` parses it. */
function nodeCheckPasses(contents: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "beam-m8-"));
  const fp = join(dir, "gen.js");
  try {
    writeFileSync(fp, contents, "utf8");
    execFileSync(process.execPath, ["--check", fp], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testScaffoldInjection(): void {
  process.stdout.write("\n[unit] scaffold_auth injection resistance\n");

  // Hostile, attacker-shaped inputs: a quote-bearing appUrl and a domain crafted
  // to break out of the string literal / neutralize the allowlist gate.
  const out = scaffoldAuth({
    provider: "google",
    framework: "express",
    mode: "internal",
    allowedDomain: 'evil.com" || true || "',
    appUrl: 'https://x.example.com/") + danger',
  });

  const authJs = out.files.find((f) => f.path === "auth.js");
  check(authJs !== undefined, "express scaffold produced auth.js");
  if (authJs) {
    check(
      !authJs.contents.includes("|| true ||"),
      "hostile allowedDomain did NOT inject into the generated gate",
    );
    check(
      authJs.contents.includes('const allowedDomain = "yourco.com"'),
      "hostile allowedDomain falls back to the placeholder (gate stays restrictive)",
    );
    check(
      nodeCheckPasses(authJs.contents),
      "generated express auth.js passes `node --check` despite hostile appUrl/domain",
    );
  }
  const snippet = out.files.find((f) => f.path === "auth-wiring.snippet.js");
  if (snippet) {
    check(nodeCheckPasses(snippet.contents), "generated express wiring snippet is syntactically valid");
  }

  // Next.js path: the domain literal must also be neutralized.
  const nx = scaffoldAuth({
    provider: "google",
    framework: "nextjs",
    mode: "internal",
    allowedDomain: 'a.com"}; evil(); //',
  });
  const authTs = nx.files.find((f) => f.path === "auth.ts");
  check(
    authTs !== undefined && authTs.contents.includes('const allowedDomain = "yourco.com"'),
    "nextjs hostile domain falls back to the placeholder literal",
  );
  check(
    authTs !== undefined && !authTs.contents.includes("evil()"),
    "nextjs hostile domain is not injected into auth.ts",
  );

  // A bad appUrl scheme falls back rather than producing a junk redirect URI.
  const badUrl = scaffoldAuth({ provider: "google", framework: "nextjs", appUrl: "javascript:alert(1)" });
  check(
    badUrl.redirectUris.every((u) => !u.startsWith("javascript:")),
    "a non-http(s) appUrl is rejected (no javascript: redirect URI)",
  );
}

/* ------------------------------------------------------------------ */
/* [tool] in-memory MCP client                                         */
/* ------------------------------------------------------------------ */

async function testMcpTools(): Promise<void> {
  process.stdout.write("\n[tool] scaffold_auth + preflight auth over an in-memory MCP client\n");

  const server = createServer();
  const client = new Client({ name: "m8-test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);

  try {
    /* ---- tool list ---- */
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    check(names.includes("scaffold_auth"), `listTools includes scaffold_auth (got ${JSON.stringify(names)})`);
    check(names.length === 13, `13 tools registered (got ${names.length}: ${JSON.stringify(names)})`);

    /* ---- preflight_scan surfaces auth.offerGoogleAuth ---- */
    const pre = await client.callTool({
      name: "preflight_scan",
      arguments: { files: APP_NO_LOGIN, mode: "product" },
    });
    check(!pre.isError, `preflight_scan not error (got ${JSON.stringify(pre.content)})`);
    const preOut = PreflightScanOutputSchema.parse(pre.structuredContent);
    check(
      preOut.auth.loginImplemented === false && preOut.auth.offerGoogleAuth === true,
      `preflight auth: no login + offerGoogleAuth (got ${JSON.stringify(preOut.auth)})`,
    );
    check(
      preOut.securityFollowups.some((f) => /scaffold_auth/.test(f)),
      "preflight securityFollowups nudges scaffold_auth when login missing",
    );

    /* ---- scaffold_auth: Next.js ---- */
    const nextRes = await client.callTool({
      name: "scaffold_auth",
      arguments: { provider: "google", framework: "nextjs", appUrl: "https://app.example.com/" },
    });
    check(!nextRes.isError, `scaffold_auth nextjs not error (got ${JSON.stringify(nextRes.content)})`);
    const nextOut = ScaffoldAuthOutputSchema.parse(nextRes.structuredContent);
    check(nextOut.framework === "nextjs", "scaffold_auth nextjs -> framework nextjs");
    check(
      nextOut.dependencies.includes("next-auth@beta"),
      `nextjs scaffold installs next-auth@beta (got ${JSON.stringify(nextOut.dependencies)})`,
    );
    check(
      nextOut.files.some((f) => f.path === "auth.ts"),
      "nextjs scaffold creates auth.ts",
    );
    check(
      nextOut.redirectUris.includes("https://app.example.com/api/auth/callback/google"),
      `nextjs redirect URI built from appUrl (got ${JSON.stringify(nextOut.redirectUris)})`,
    );
    check(
      nextOut.envVars.some((e) => e.key === "AUTH_SECRET" && e.secret) &&
        nextOut.envVars.some((e) => e.key === "AUTH_GOOGLE_SECRET" && e.secret),
      "nextjs scaffold lists AUTH_SECRET + AUTH_GOOGLE_SECRET as secret env vars",
    );

    /* ---- scaffold_auth: Express, internal mode w/ allowlist ---- */
    const expRes = await client.callTool({
      name: "scaffold_auth",
      arguments: {
        provider: "google",
        framework: "express",
        mode: "internal",
        allowedDomain: "acme.com",
        appUrl: "https://acme.example.com",
      },
    });
    check(!expRes.isError, `scaffold_auth express not error (got ${JSON.stringify(expRes.content)})`);
    const expOut = ScaffoldAuthOutputSchema.parse(expRes.structuredContent);
    check(
      expOut.dependencies.includes("passport-google-oauth20") &&
        expOut.dependencies.includes("express-session"),
      `express scaffold installs passport-google-oauth20 + express-session (got ${JSON.stringify(expOut.dependencies)})`,
    );
    check(
      expOut.files.some((f) => f.contents.includes("acme.com")),
      "internal-mode express scaffold gates to the allowed domain in code",
    );
    check(
      expOut.warnings.some((w) => /acme\.com/.test(w)),
      "internal-mode express scaffold warns about the domain gate",
    );

    /* ---- scaffold_auth: unknown stack -> generic ---- */
    const genRes = await client.callTool({
      name: "scaffold_auth",
      arguments: { provider: "google", stack: "rails-7-ruby" },
    });
    const genOut = ScaffoldAuthOutputSchema.parse(genRes.structuredContent);
    check(genOut.framework === "generic", `unknown stack -> generic framework (got ${genOut.framework})`);
    check(
      typeof firstText(genRes.content) === "string",
      "scaffold_auth echoes JSON text content",
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

/* ------------------------------------------------------------------ */
/* [http] hardened transport                                           */
/* ------------------------------------------------------------------ */

const HTTP_ENV_KEYS = [
  "OAUTH_ISSUER",
  "OAUTH_AUDIENCE",
  "OAUTH_JWT_SECRET",
  "OAUTH_JWT_PUBLIC_KEY",
  "BEAM_HTTP_HOST",
  "BEAM_HTTP_ALLOW_INSECURE",
  "BEAM_HTTP_ALLOWED_HOSTS",
  "BEAM_HTTP_ALLOWED_ORIGINS",
] as const;

function snapshot(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of HTTP_ENV_KEYS) out[k] = process.env[k];
  return out;
}
function restore(saved: Record<string, string | undefined>): void {
  for (const k of HTTP_ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function listenEphemeral(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address() as AddressInfo | null;
      if (addr === null || typeof addr === "string") return reject(new Error("no port"));
      resolve(addr.port);
    });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
function initBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m8", version: "0" } },
  });
}

async function testHttpHardening(): Promise<void> {
  process.stdout.write("\n[http] DNS-rebinding guard + refuse-insecure\n");

  const saved = snapshot();
  // No OAuth -> a passing request reaches the MCP server (not 401); a foreign
  // Origin is rejected at the guard (403) before auth/MCP.
  for (const k of HTTP_ENV_KEYS) delete process.env[k];

  const server = createBeamHttpServer();
  try {
    const port = await listenEphemeral(server);
    const base = `http://127.0.0.1:${port}`;

    /* ---- foreign Origin -> 403 ---- */
    const evil = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Origin: "http://evil.example.com",
      },
      body: initBody(),
    });
    check(evil.status === 403, `POST /mcp with foreign Origin -> 403 (got ${evil.status})`);
    await evil.text();

    /* ---- loopback (no Origin) -> NOT 403 (and not 401, no OAuth) ---- */
    const ok = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initBody(),
    });
    check(ok.status !== 403 && ok.status !== 401, `POST /mcp loopback no-Origin -> served, not 403/401 (got ${ok.status})`);
    await ok.text();
  } finally {
    await closeServer(server);
  }

  /* ---- startBeamHttpServer refuses no-auth on 0.0.0.0 ---- */
  let threw = false;
  try {
    // No OAuth env, no allow-insecure -> must throw BEFORE binding.
    startBeamHttpServer(0, "0.0.0.0");
  } catch {
    threw = true;
  }
  check(threw, "startBeamHttpServer(0, '0.0.0.0') with no OAuth refuses to start (throws)");

  /* ---- loopback default binds fine ---- */
  const loop = startBeamHttpServer(0, "127.0.0.1");
  await new Promise((r) => loop.once("listening", r));
  check(loop.listening === true, "startBeamHttpServer on 127.0.0.1 binds (loopback is allowed no-auth)");
  await closeServer(loop);

  restore(saved);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  testDetectAuth();
  testClientSecret();
  testScaffoldInjection();
  await testMcpTools();
  await testHttpHardening();
  process.stdout.write(`\nm8.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm8.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
