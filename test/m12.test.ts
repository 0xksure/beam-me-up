/**
 * m12.test.ts — OFFLINE tests for M9 P3a: the MCP TOOL-OUTPUT CONTRACTS.
 *
 * 100% offline (no network, no DB, no KMS): the tool handler functions are
 * called DIRECTLY with a hand-rolled in-memory CredentialContext (the per-user
 * `ctx` seam). No server, no transport. Mirrors the tiny check() harness in
 * test/m5.test.ts / test/m11.test.ts.
 *
 * Covers:
 *   (A) RESULT-ENVELOPE shapes — needsConnect / needsConfirmation carry a
 *       `status` discriminator + a server-owned `host` directive (speak +
 *       buttons); success outputs carry costSoFar + host on the ctx path.
 *   (B) the confirmToken STRUCTURAL gate — a deploy WITHOUT a valid token ->
 *       needsConfirmation + NO side effect; WITH a valid token -> proceeds/
 *       attempts the action (no longer gated); a TAMPERED / EXPIRED token ->
 *       needsConfirmation again.
 *   (C) needsConnect on a missing vault connection (ctx path) vs the env-var
 *       message on the self-host (no-ctx) path.
 *   (D) the COPY LINT — every user-facing string emitted (host.speak, button
 *       labels, headline / reassurance / statusLine) is scanned and must NOT
 *       contain any developer-speak term.
 *
 * Wired to `npm run test:m12`.
 */
import {
  createDeployTarget,
  deployTool,
  setEnvVarsTool,
  getDeployLogs,
  provisionDatabaseTool,
  checkCredentials,
  listConnections,
  buildNeedsConnect,
  buildRecovery,
  recoveryHost,
  buildNeedsConfirmation,
  mintConfirmToken,
  verifyConfirmToken,
} from "@beam-me-up/tools";
import type { CredentialContext, ConnectionInfo } from "@beam-me-up/adapters";
import { createServer } from "@beam-me-up/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/* ------------------------------------------------------------------ */
/* Tiny assertion harness (mirrors m5 / m11)                           */
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

/* ------------------------------------------------------------------ */
/* In-memory CredentialContext (the per-user ctx seam)                 */
/* ------------------------------------------------------------------ */

type FakeConn = ConnectionInfo & { token?: string };

function makeCtx(opts: {
  subject: string;
  connections: FakeConn[];
}): CredentialContext {
  const find = (p: string) => opts.connections.find((c) => c.provider === p);
  return {
    subject: opts.subject,
    resolve: async (provider) => {
      const c = find(provider);
      if (!c || c.status !== "active") return null;
      return { token: c.token ?? "tok" };
    },
    resolveDb: async (engine) => {
      const provider = engine === "postgres" ? "neon" : "upstash";
      const c = find(provider);
      if (!c || c.status !== "active") return null;
      return engine === "postgres"
        ? { apiKey: c.token ?? "key" }
        : { email: "x@y.z", apiKey: c.token ?? "key" };
    },
    listConnections: async () =>
      opts.connections.map((c) => ({
        provider: c.provider,
        providerAccountId: c.providerAccountId,
        status: c.status,
      })),
  };
}

/* ------------------------------------------------------------------ */
/* Copy-lint: the merge-blocking developer-speak scanner               */
/* ------------------------------------------------------------------ */

const BANNED = [
  "token",
  "env var",
  "environment variable",
  "api key",
  "secret",
  "scope",
  "oauth",
  "client id",
  "console",
];

/** Collect every user-facing string from a result envelope. */
function userFacingStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return acc;
  const obj = value as Record<string, unknown>;
  // host.speak + button labels
  if (obj.host && typeof obj.host === "object") {
    const host = obj.host as Record<string, unknown>;
    if (typeof host.speak === "string") acc.push(host.speak);
    if (Array.isArray(host.buttons)) {
      for (const b of host.buttons) {
        if (b && typeof (b as Record<string, unknown>).label === "string") {
          acc.push((b as Record<string, unknown>).label as string);
        }
      }
    }
  }
  // recovery / connection fields
  for (const key of ["headline", "reassurance", "statusLine", "displayName", "actionSummary"]) {
    if (typeof obj[key] === "string") acc.push(obj[key] as string);
  }
  if (Array.isArray(obj.actions)) {
    for (const a of obj.actions) {
      if (a && typeof (a as Record<string, unknown>).label === "string") {
        acc.push((a as Record<string, unknown>).label as string);
      }
    }
  }
  if (typeof obj.label === "string") acc.push(obj.label);
  // recurse into arrays + nested objects
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) v.forEach((x) => userFacingStrings(x, acc));
    else if (v && typeof v === "object") userFacingStrings(v, acc);
  }
  return acc;
}

function lintStrings(strings: string[], where: string): void {
  for (const s of strings) {
    const lower = s.toLowerCase();
    for (const term of BANNED) {
      check(
        !lower.includes(term),
        `copy-lint: ${where} must not contain "${term}" — got: ${JSON.stringify(s.slice(0, 80))}`,
      );
    }
  }
}

/* ================================================================== */
/* (A) RESULT-ENVELOPE shapes                                          */
/* ================================================================== */

async function testEnvelopeShapes(): Promise<void> {
  process.stdout.write("\n[A] result-envelope shapes (status + host directive)\n");

  // needsConnect
  const nc = buildNeedsConnect({ provider: "vercel", reason: "no_connection" });
  check(nc.status === "needsConnect", "needsConnect: status discriminator");
  check(typeof nc.host.speak === "string" && nc.host.speak.length > 0, "needsConnect: host.speak present");
  check(nc.host.buttons.length >= 1, "needsConnect: at least one button");
  check(nc.host.buttons[0]?.action.kind === "openUrl", "needsConnect: button opens the Connect URL");
  check(nc.resumeHint === "autoProbe", "needsConnect: resumeHint autoProbe");
  check(nc.safety.free === true && nc.safety.canSpendMoney === false, "needsConnect: safety reassurance flags");

  // needsConfirmation
  const minted = mintConfirmToken({
    tool: "deploy",
    subject: "sam",
    args: { provider: "vercel", projectName: "recipe-app" },
    destinations: [{ provider: "vercel", accountLabel: "sam@gmail.com" }],
  });
  const conf = buildNeedsConfirmation({
    tool: "deploy",
    resourceName: "recipe-app",
    destinations: [
      { provider: "vercel", role: "hosting", accountLabel: "sam@gmail.com", teamLabel: "Sam's personal" },
    ],
    args: { provider: "vercel", projectName: "recipe-app" },
    confirmToken: minted.token,
    confirmTokenExpiresAt: minted.expiresAtIso,
  });
  check(conf.status === "needsConfirmation", "needsConfirmation: status discriminator");
  check(conf.costSoFar === "$0", "needsConfirmation: costSoFar $0 money promise");
  check(conf.host.buttons.length === 2, "needsConfirmation: Yes + different-account buttons");
  const yes = conf.host.buttons[0];
  check(
    yes !== undefined &&
      yes.action.kind === "callTool" &&
      yes.action.tool === "deploy" &&
      (yes.action.args as Record<string, unknown>).confirmToken === minted.token,
    "needsConfirmation: Yes button re-invokes the SAME tool WITH confirmToken",
  );
  check(
    conf.destinations[0]?.accountLabel === "sam@gmail.com",
    "needsConfirmation: echoes the destination account label from the vault",
  );

  // recovery deck
  const rec = buildRecovery("reconnect_expired", "vercel");
  check(rec.kind === "reconnect_expired", "recovery: kind set");
  check(rec.errorCode === "vercel.expired", "recovery: stable errorCode (host bookkeeping)");
  const recHost = recoveryHost(rec);
  check(recHost.speak.includes("Vercel"), "recovery: speak uses the Vercel display name");
}

/* ================================================================== */
/* (B) the confirmToken STRUCTURAL gate                               */
/* ================================================================== */

async function testConfirmGate(): Promise<void> {
  process.stdout.write("\n[B] confirmToken structural gate (no side effect without a valid token)\n");

  // A subject WITH an active vercel connection so the gate (not needsConnect) fires.
  const ctx = makeCtx({
    subject: "sam",
    connections: [{ provider: "vercel", providerAccountId: "sam@gmail.com", status: "active", token: "v-tok" }],
  });

  const args = {
    provider: "vercel" as const,
    targetId: "tgt_1",
    projectName: "recipe-app",
    files: [{ path: "index.html", content: "<h1>hi</h1>" }],
  };

  // (1) WITHOUT a confirmToken -> needsConfirmation, NO side effect.
  const gated = await deployTool(args, ctx);
  check(
    (gated as { status?: string }).status === "needsConfirmation",
    "deploy WITHOUT confirmToken -> needsConfirmation (gate fires)",
  );
  check(
    (gated as { url?: string }).url === undefined &&
      (gated as { deploymentId?: string }).deploymentId === undefined,
    "deploy WITHOUT confirmToken performed NO side effect (no deploymentId/url)",
  );
  const token = (gated as { confirmToken: string }).confirmToken;
  check(typeof token === "string" && token.length > 0, "gate minted a confirmToken to echo back");

  // (2) the minted token VERIFIES for these exact (subject, tool, args, dest).
  const destinations = [{ provider: "vercel", accountLabel: "sam@gmail.com" }];
  check(
    verifyConfirmToken({ token, tool: "deploy", subject: "sam", args, destinations }),
    "minted confirmToken verifies for the exact (subject, tool, args, destination)",
  );

  // (3) WITH the valid token -> the gate is PASSED (no longer needsConfirmation).
  //     It then attempts the real action (and, offline, returns a provider
  //     { error } — which proves it got PAST the structural gate).
  const proceeded = await deployTool({ ...args, confirmToken: token } as typeof args & { confirmToken: string }, ctx);
  check(
    (proceeded as { status?: string }).status !== "needsConfirmation",
    "deploy WITH a valid confirmToken is no longer gated (proceeds/attempts the action)",
  );

  // (4) a TAMPERED token -> gate re-fires.
  const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  const reGatedTamper = await deployTool({ ...args, confirmToken: tampered } as typeof args & { confirmToken: string }, ctx);
  check(
    (reGatedTamper as { status?: string }).status === "needsConfirmation",
    "deploy with a TAMPERED confirmToken -> needsConfirmation again (gate re-fires)",
  );

  // (5) an EXPIRED token -> verification fails (re-mint with a past exp).
  const expired = mintConfirmToken({
    tool: "deploy",
    subject: "sam",
    args,
    destinations,
    nowSeconds: 1_000,
    ttlSeconds: 1, // exp = 1001
  });
  check(
    !verifyConfirmToken({ token: expired.token, tool: "deploy", subject: "sam", args, destinations, nowSeconds: 2_000 }),
    "an EXPIRED confirmToken fails verification (gate would re-fire)",
  );

  // (6) a token minted for a DIFFERENT destination cannot authorize this create.
  const otherDest = mintConfirmToken({
    tool: "deploy",
    subject: "sam",
    args,
    destinations: [{ provider: "vercel", accountLabel: "someone-else@evil.com" }],
  });
  const crossUse = await deployTool({ ...args, confirmToken: otherDest.token } as typeof args & { confirmToken: string }, ctx);
  check(
    (crossUse as { status?: string }).status === "needsConfirmation",
    "a confirmToken bound to a DIFFERENT destination cannot authorize this deploy",
  );

  // (7) get_deploy_logs (read-only) does NOT gate.
  const logs = await getDeployLogs({ provider: "vercel", deploymentId: "dep_1" }, ctx);
  check(
    (logs as { status?: string }).status !== "needsConfirmation",
    "get_deploy_logs (read-only) does NOT gate on a confirmToken",
  );

  // create_deploy_target + provision_database + set_env_vars also gate.
  const ctGate = await createDeployTarget({ provider: "vercel", projectName: "recipe-app" }, ctx);
  check((ctGate as { status?: string }).status === "needsConfirmation", "create_deploy_target gates without a token");
  const seGate = await setEnvVarsTool({ provider: "vercel", targetId: "t1", vars: [] }, ctx);
  check((seGate as { status?: string }).status === "needsConfirmation", "set_env_vars gates without a token");
  const dbCtx = makeCtx({
    subject: "sam",
    connections: [{ provider: "neon", providerAccountId: "sam@gmail.com", status: "active", token: "n" }],
  });
  const pdGate = await provisionDatabaseTool({ engine: "postgres", name: "db1" }, dbCtx);
  check((pdGate as { status?: string }).status === "needsConfirmation", "provision_database gates without a token");
}

/* ================================================================== */
/* (C) needsConnect (ctx) vs env-var message (no-ctx)                 */
/* ================================================================== */

async function testNeedsConnectVsEnv(): Promise<void> {
  process.stdout.write("\n[C] needsConnect on the vault path vs env-var message on self-host\n");

  // (1) ctx path, NO connection -> needsConnect, never "set the VERCEL_TOKEN".
  const ctxNoConn = makeCtx({ subject: "sam", connections: [] });
  const dep = await deployTool(
    { provider: "vercel", targetId: "t", projectName: "p", files: [{ path: "a", content: "b" }] },
    ctxNoConn,
  );
  check((dep as { status?: string }).status === "needsConnect", "ctx + no connection -> needsConnect (deploy)");
  check(
    (dep as { connectUrl?: string }).connectUrl?.includes("/connect/vercel") === true,
    "needsConnect carries a /connect/<provider> URL placeholder",
  );

  const prov = await provisionDatabaseTool({ engine: "postgres", name: "db" }, ctxNoConn);
  check((prov as { status?: string }).status === "needsConnect", "ctx + no connection -> needsConnect (provision_database)");

  // (2) no-ctx self-host path -> the env-var message is RETAINED verbatim.
  const savedV = process.env.VERCEL_TOKEN;
  const savedN = process.env.NEON_API_KEY;
  try {
    delete process.env.VERCEL_TOKEN;
    delete process.env.NEON_API_KEY;
    const depEnv = await deployTool({
      provider: "vercel",
      targetId: "t",
      projectName: "p",
      files: [{ path: "a", content: "b" }],
    });
    check(
      (depEnv as { error?: string }).error?.includes("VERCEL_TOKEN") === true,
      "no-ctx self-host path KEEPS the 'set the VERCEL_TOKEN' message (behaviour unchanged)",
    );
    const provEnv = await provisionDatabaseTool({ engine: "postgres", name: "db" });
    check(
      (provEnv as { error?: string }).error?.includes("NEON_API_KEY") === true,
      "no-ctx self-host path KEEPS the 'set the NEON_API_KEY' message (behaviour unchanged)",
    );
  } finally {
    if (savedV === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = savedV;
    if (savedN === undefined) delete process.env.NEON_API_KEY;
    else process.env.NEON_API_KEY = savedN;
  }

  // (3) check_credentials: ctx path says "(not connected)", never "(set NEON_API_KEY)".
  const creds = await checkCredentials(ctxNoConn);
  check(
    creds.missing.every((m) => m.includes("(not connected)")),
    "ctx check_credentials.missing reads '(not connected)' — never an env-var name",
  );
  check(creds.progress.total > 0, "ctx check_credentials carries a progress tally");
}

/* ================================================================== */
/* (D) the COPY LINT — scan every emitted user-facing string          */
/* ================================================================== */

async function testCopyLint(): Promise<void> {
  process.stdout.write("\n[D] copy lint: no developer-speak in any emitted user-facing string\n");

  const all: string[] = [];

  // every needsConnect (all providers + reasons)
  for (const provider of ["github", "vercel", "digitalocean", "neon", "upstash"] as const) {
    for (const reason of ["no_connection", "expired", "revoked"] as const) {
      userFacingStrings(buildNeedsConnect({ provider, reason }), all);
    }
  }

  // every recovery row
  const recoveryKinds = [
    "connect",
    "reconnect_expired",
    "reconnect_failed",
    "reconnect_revoked",
    "wrong_account",
    "connect_abandoned",
  ] as const;
  for (const provider of ["github", "vercel", "digitalocean"] as const) {
    for (const kind of recoveryKinds) {
      const rec = buildRecovery(kind, provider);
      userFacingStrings(rec, all);
      userFacingStrings({ host: recoveryHost(rec) }, all);
    }
  }
  const dbm = buildRecovery("db_needs_managed", "database");
  userFacingStrings(dbm, all);
  userFacingStrings({ host: recoveryHost(dbm) }, all);

  // every needsConfirmation (each gating tool)
  const minted = mintConfirmToken({
    tool: "deploy",
    subject: "sam",
    args: { provider: "vercel" },
    destinations: [{ provider: "vercel", accountLabel: "sam@gmail.com" }],
  });
  for (const tool of ["deploy", "create_deploy_target", "provision_database", "set_env_vars"] as const) {
    userFacingStrings(
      buildNeedsConfirmation({
        tool,
        resourceName: "recipe-app",
        destinations: [
          { provider: "github", role: "code", accountLabel: "sam@gmail.com" },
          { provider: "vercel", role: "hosting", accountLabel: "sam@gmail.com", teamLabel: "Sam's personal" },
          { provider: "neon", role: "database", accountLabel: "sam@gmail.com", freeTier: true },
        ],
        args: { provider: "vercel" },
        confirmToken: minted.token,
        confirmTokenExpiresAt: minted.expiresAtIso,
      }),
      all,
    );
  }

  // list_connections + check_credentials (ctx path) emitted copy
  const ctx = makeCtx({
    subject: "sam",
    connections: [
      { provider: "vercel", providerAccountId: "sam@gmail.com", status: "active" },
      { provider: "neon", providerAccountId: "sam@gmail.com", status: "expired" },
    ],
  });
  userFacingStrings(await listConnections(ctx), all);
  userFacingStrings(await checkCredentials(ctx), all);
  userFacingStrings(await listConnections(), all); // no-ctx view too

  check(all.length > 40, `collected a broad set of user-facing strings to lint (got ${all.length})`);
  lintStrings(all, "emitted UX copy");

  // The copy lint actually CATCHES a violation (guards against a no-op scanner).
  // Use a direct scan here (not the check()-based lintStrings, which would print
  // a misleading FAIL line) so this proves the scanner is not a no-op.
  const violating = "Please paste your VERCEL_TOKEN here".toLowerCase();
  const detected = BANNED.some((term) => violating.includes(term));
  check(detected, "copy lint CATCHES a developer-speak violation (not a no-op)");

  // Provider display names are correct: DigitalOcean, never "DO".
  const doConnect = buildNeedsConnect({ provider: "digitalocean", reason: "no_connection" });
  check(doConnect.host.speak.includes("DigitalOcean"), "DigitalOcean spelled out (never 'DO')");
  const doStrings = userFacingStrings(doConnect);
  check(
    !doStrings.some((s) => /\bDO\b/.test(s)),
    "no user-facing string abbreviates DigitalOcean to 'DO'",
  );
}

/* ================================================================== */
/* (E) END-TO-END over the MCP SDK (the layer the direct tests skip)   */
/* ================================================================== */

/** Parse the JSON envelope from an MCP tool result's text content (or null). */
function envelopeOf(result: unknown): Record<string, unknown> | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null; // a flat error rides as a plain string, not JSON
  }
}

/**
 * Drive the gate THROUGH createServer + the MCP SDK transport — the exact path
 * the direct-handler tests bypass, where the two critical wiring bugs lived:
 *   (1) the SDK strips an undeclared confirmToken during input validation, and
 *   (2) the SDK rejects a non-error result that has an outputSchema but no
 *       structuredContent (turning needsConnect/needsConfirmation into -32602).
 */
async function testEndToEndOverSdk(): Promise<void> {
  process.stdout.write("\n[E] end-to-end over the MCP SDK (confirmToken survives input validation; envelopes are not -32602)\n");

  const ctx = makeCtx({
    subject: "alice",
    connections: [
      { provider: "vercel", providerAccountId: "alices-team", status: "active", token: "alice-vercel-tok" },
    ],
  });
  const server = createServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "m12-e2e", version: "0.0.0" });
  await client.connect(clientT);

  try {
    const deployArgs = { provider: "vercel", targetId: "t1", projectName: "recipe-app" };

    // Call 1 (no confirmToken): a PARSEABLE needsConfirmation, not isError, not -32602.
    const r1 = await client.callTool({ name: "deploy", arguments: deployArgs });
    check(r1.isError !== true, "e2e: needsConfirmation is NOT delivered as an MCP error");
    const env1 = envelopeOf(r1);
    check(env1?.status === "needsConfirmation", `e2e: deploy without a token -> needsConfirmation (got ${env1?.status})`);
    const confirmToken = env1?.confirmToken;
    check(typeof confirmToken === "string" && confirmToken.length > 0, "e2e: needsConfirmation carries a confirmToken");

    // Call 2 (same args + confirmToken): the SDK must PRESERVE confirmToken (it is a
    // declared input field) so the gate PASSES. `files` is omitted, so the deploy
    // then fails fast on input-completeness (no network) — the point is the result
    // is NO LONGER needsConfirmation, and no -32602 ever reached the client.
    const r2 = await client.callTool({ name: "deploy", arguments: { ...deployArgs, confirmToken } });
    const text2 = (r2.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? "";
    const status2 = envelopeOf(r2)?.status;
    check(status2 !== "needsConfirmation", `e2e: a valid confirmToken PASSES the gate, not an infinite loop (got ${status2 ?? text2.slice(0, 60)})`);
    check(!text2.includes("-32602"), "e2e: no MCP output-validation (-32602) error reached the client");

    // Call 3 (a provider with NO connection): a PARSEABLE needsConnect, not -32602.
    const r3 = await client.callTool({
      name: "deploy",
      arguments: { provider: "digitalocean", targetId: "t2", projectName: "x", image: "registry.example/x:1" },
    });
    check(r3.isError !== true, "e2e: needsConnect is NOT delivered as an MCP error");
    const env3 = envelopeOf(r3);
    check(env3?.status === "needsConnect", `e2e: no connection -> needsConnect (got ${env3?.status})`);
  } finally {
    await client.close();
  }
}

/* ================================================================== */
/* (F) confirm-secret HOSTED GUARDRAIL (no public-dev-key bypass)       */
/* ================================================================== */

async function testConfirmSecretHostedGuardrail(): Promise<void> {
  process.stdout.write("\n[F] confirm-secret hosted guardrail (the public dev key can't bypass the gate on hosted)\n");
  const savedTier = process.env.BEAM_TIER;
  const savedSecret = process.env.BEAM_CONFIRM_TOKEN_SECRET;
  const mintArgs = {
    tool: "deploy",
    subject: "alice",
    args: { provider: "vercel", projectName: "x" },
    destinations: [{ provider: "vercel", accountLabel: "alice@example.com" }],
  };
  try {
    // Hosted + no secret -> minting MUST throw (no fallback to the public dev key).
    process.env.BEAM_TIER = "hosted";
    delete process.env.BEAM_CONFIRM_TOKEN_SECRET;
    let threw = false;
    try {
      mintConfirmToken(mintArgs);
    } catch {
      threw = true;
    }
    check(threw, "hosted + no BEAM_CONFIRM_TOKEN_SECRET -> mintConfirmToken THROWS (no dev-key bypass)");

    // Hosted + a real secret -> works again.
    process.env.BEAM_CONFIRM_TOKEN_SECRET = "a-strong-operator-secret-0123456789";
    const t = mintConfirmToken(mintArgs);
    check(typeof t.token === "string" && t.token.length > 0, "hosted + a real secret -> mintConfirmToken works");

    // Self-host (not hosted) + no secret -> the dev default is allowed.
    delete process.env.BEAM_TIER;
    delete process.env.BEAM_CONFIRM_TOKEN_SECRET;
    const t2 = mintConfirmToken(mintArgs);
    check(typeof t2.token === "string" && t2.token.length > 0, "self-host + no secret -> dev default still allowed");
  } finally {
    if (savedTier === undefined) delete process.env.BEAM_TIER;
    else process.env.BEAM_TIER = savedTier;
    if (savedSecret === undefined) delete process.env.BEAM_CONFIRM_TOKEN_SECRET;
    else process.env.BEAM_CONFIRM_TOKEN_SECRET = savedSecret;
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testEnvelopeShapes();
  await testConfirmGate();
  await testNeedsConnectVsEnv();
  await testCopyLint();
  await testEndToEndOverSdk();
  await testConfirmSecretHostedGuardrail();
  process.stdout.write(`\nm12.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm12.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
