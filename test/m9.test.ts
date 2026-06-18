/**
 * m9.test.ts - offline tests for the M9 P1 per-user identity SEAM.
 *
 * 100% offline (no network, no DB). M9 P1 only THREADS an optional
 * CredentialContext through the credential resolvers + tools + createServer
 * WITHOUT changing existing env-based behaviour. These tests prove the seam:
 *
 *   (a) getProviderToken(provider, ctxStub) returns the ctx token, WINNING over
 *       a set env var (the per-user resolution wins when ctx is present).
 *   (b) With NO ctx, getProviderToken / getDbCredentials still read process.env
 *       (toggle the env vars on/off and observe the result flip).
 *   (c) createServer(ctxStub) forwards ctx so a credentialed path resolves from
 *       ctx not env: check_credentials, driven via an in-memory MCP client,
 *       reports the providers the STUB exposes even though no env var is set.
 *   (d) Two different ctx subjects resolve independently (isolation smoke): one
 *       subject's stub resolves vercel-only, the other neon-only, and neither
 *       leaks into the other.
 *
 * Wired to `npm run test:m9` (tsx test/m9.test.ts). Mirrors the tiny check()
 * harness in test/m5.test.ts and the in-memory client helper in test/m7.test.ts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  getProviderToken,
  getDbCredentials,
  type CredentialContext,
  type ProviderToken,
  type DbEngine,
  type NeonCreds,
  type UpstashCreds,
} from "@beam-me-up/adapters";
import { createServer } from "@beam-me-up/server";

/* ------------------------------------------------------------------ */
/* Tiny assertion harness with PASS/FAIL printing (mirrors m5)         */
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
/* CredentialContext stubs (the P2 vault is not built yet)             */
/* ------------------------------------------------------------------ */

/**
 * Build a CredentialContext stub from a fixed, in-memory map of what THIS
 * subject has "connected". A null entry means "not connected" so callers see
 * the same null contract the env path produces.
 */
function makeCtx(
  subject: string,
  connected: {
    vercel?: ProviderToken | null;
    digitalocean?: ProviderToken | null;
    postgres?: NeonCreds | null;
    redis?: UpstashCreds | null;
  },
): CredentialContext {
  return {
    subject,
    async resolve(provider: "vercel" | "digitalocean"): Promise<ProviderToken | null> {
      return connected[provider] ?? null;
    },
    async resolveDb(engine: DbEngine): Promise<NeonCreds | UpstashCreds | null> {
      return connected[engine] ?? null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Env snapshot/restore for the provider/db env vars                   */
/* ------------------------------------------------------------------ */

const ENV_KEYS = [
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "DIGITALOCEAN_TOKEN",
  "NEON_API_KEY",
  "UPSTASH_EMAIL",
  "UPSTASH_API_KEY",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/* ------------------------------------------------------------------ */
/* In-memory MCP client (mirrors test/m7.test.ts connectClient)        */
/* ------------------------------------------------------------------ */

async function connectClient(
  ctx?: CredentialContext,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(ctx);
  const client = new Client({ name: "beam-me-up-m9-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

type CredsResult = {
  vercel: boolean;
  digitalocean: boolean;
  neon: boolean;
  upstash: boolean;
  configured: string[];
  missing: string[];
};

async function callCheckCredentials(client: Client): Promise<CredsResult> {
  const res = await client.callTool({
    name: "check_credentials",
    arguments: {},
  });
  check(!res.isError, "check_credentials returns a non-error result");
  return res.structuredContent as CredsResult;
}

/* ================================================================== */
/* (a) ctx WINS over env in getProviderToken                          */
/* ================================================================== */

async function testCtxWinsOverEnv(): Promise<void> {
  process.stdout.write("\n[a] ctx resolution WINS over a set env var\n");

  const saved = snapshotEnv();
  try {
    // Set a real env token: without ctx this is what would be returned.
    process.env.VERCEL_TOKEN = "env-vercel-token";

    // ctx exposes a DIFFERENT vercel token for this subject.
    const ctx = makeCtx("user-A", {
      vercel: { token: "ctx-vercel-token", teamId: "ctx-team" },
    });

    const fromCtx = await getProviderToken("vercel", ctx);
    check(
      fromCtx !== null && fromCtx.token === "ctx-vercel-token",
      `getProviderToken("vercel", ctx) returns the ctx token (got ${JSON.stringify(fromCtx)})`,
    );
    check(
      fromCtx !== null && fromCtx.teamId === "ctx-team",
      "ctx token carries the ctx teamId, not the env one",
    );

    // Sanity: without ctx the SAME call returns the env token, proving the only
    // difference is the presence of ctx.
    const fromEnv = await getProviderToken("vercel");
    check(
      fromEnv !== null && fromEnv.token === "env-vercel-token",
      `getProviderToken("vercel") with no ctx still reads env (got ${JSON.stringify(fromEnv)})`,
    );

    // A provider the ctx subject has NOT connected resolves null even though an
    // env var is present (ctx is authoritative when supplied).
    process.env.DIGITALOCEAN_TOKEN = "env-do-token";
    check(
      (await getProviderToken("digitalocean", ctx)) === null,
      "ctx without a digitalocean connection returns null, ignoring the env DIGITALOCEAN_TOKEN",
    );
  } finally {
    restoreEnv(saved);
  }
}

/* ================================================================== */
/* (b) no ctx -> env reads still work (toggle env)                    */
/* ================================================================== */

async function testNoCtxReadsEnv(): Promise<void> {
  process.stdout.write("\n[b] no ctx -> getProviderToken/getDbCredentials read env\n");

  const saved = snapshotEnv();
  try {
    /* ---- env UNSET -> null --------------------------------------- */
    clearEnv();
    check((await getProviderToken("vercel")) === null, "env unset: getProviderToken(vercel) === null");
    check((await getProviderToken("digitalocean")) === null, "env unset: getProviderToken(digitalocean) === null");
    check((await getDbCredentials("postgres")) === null, "env unset: getDbCredentials(postgres) === null");
    check((await getDbCredentials("redis")) === null, "env unset: getDbCredentials(redis) === null");

    /* ---- env SET -> resolved ------------------------------------- */
    process.env.VERCEL_TOKEN = "v-tok";
    process.env.DIGITALOCEAN_TOKEN = "do-tok";
    process.env.NEON_API_KEY = "neon-key";
    process.env.UPSTASH_EMAIL = "me@example.com";
    process.env.UPSTASH_API_KEY = "up-key";

    const v = await getProviderToken("vercel");
    check(v !== null && v.token === "v-tok", "env set: getProviderToken(vercel) reads VERCEL_TOKEN");
    const d = await getProviderToken("digitalocean");
    check(d !== null && d.token === "do-tok", "env set: getProviderToken(digitalocean) reads DIGITALOCEAN_TOKEN");
    const pg = (await getDbCredentials("postgres")) as NeonCreds | null;
    check(pg !== null && pg.apiKey === "neon-key", "env set: getDbCredentials(postgres) reads NEON_API_KEY");
    const rd = (await getDbCredentials("redis")) as UpstashCreds | null;
    check(
      rd !== null && rd.email === "me@example.com" && rd.apiKey === "up-key",
      "env set: getDbCredentials(redis) reads UPSTASH_EMAIL + UPSTASH_API_KEY",
    );
  } finally {
    restoreEnv(saved);
  }
}

/* ================================================================== */
/* (c) createServer(ctx) forwards ctx into check_credentials          */
/* ================================================================== */

async function testCreateServerForwardsCtx(): Promise<void> {
  process.stdout.write("\n[c] createServer(ctx) forwards ctx (check_credentials resolves from ctx, not env)\n");

  const saved = snapshotEnv();
  try {
    // Deliberately leave the env BLANK: if ctx were ignored, every provider
    // would report false. The ctx exposes vercel + neon for this subject.
    clearEnv();
    const ctx = makeCtx("user-C", {
      vercel: { token: "ctx-v" },
      postgres: { apiKey: "ctx-neon" },
    });

    const { client, close } = await connectClient(ctx);
    try {
      const creds = await callCheckCredentials(client);
      check(creds.vercel === true, "ctx exposes vercel -> check_credentials.vercel === true (env blank)");
      check(creds.neon === true, "ctx exposes neon -> check_credentials.neon === true (env blank)");
      check(creds.digitalocean === false, "ctx has no digitalocean -> check_credentials.digitalocean === false");
      check(creds.upstash === false, "ctx has no upstash -> check_credentials.upstash === false");
      check(
        creds.configured.includes("vercel") && creds.configured.includes("neon"),
        `configured lists the ctx-connected providers (got ${JSON.stringify(creds.configured)})`,
      );
    } finally {
      await close();
    }

    // Control: with NO ctx and blank env, every provider reports false — proving
    // the true values above came from ctx, not leaked env.
    const { client: c2, close: close2 } = await connectClient();
    try {
      const creds = await callCheckCredentials(c2);
      check(
        !creds.vercel && !creds.digitalocean && !creds.neon && !creds.upstash,
        `no ctx + blank env -> all providers false (got ${JSON.stringify(creds.configured)})`,
      );
    } finally {
      await close2();
    }
  } finally {
    restoreEnv(saved);
  }
}

/* ================================================================== */
/* (d) two subjects resolve independently (isolation smoke)           */
/* ================================================================== */

async function testSubjectIsolation(): Promise<void> {
  process.stdout.write("\n[d] two ctx subjects resolve independently (isolation smoke)\n");

  const saved = snapshotEnv();
  try {
    clearEnv();

    // Subject 1 connected vercel only; subject 2 connected neon only.
    const ctx1 = makeCtx("subject-1", { vercel: { token: "s1-vercel" } });
    const ctx2 = makeCtx("subject-2", { postgres: { apiKey: "s2-neon" } });

    // Direct-resolver isolation.
    check(
      (await getProviderToken("vercel", ctx1))?.token === "s1-vercel",
      "subject-1 resolves its own vercel token",
    );
    check((await getDbCredentials("postgres", ctx1)) === null, "subject-1 has no neon connection");
    check((await getProviderToken("vercel", ctx2)) === null, "subject-2 has no vercel connection");
    check(
      ((await getDbCredentials("postgres", ctx2)) as NeonCreds | null)?.apiKey === "s2-neon",
      "subject-2 resolves its own neon credential",
    );

    // End-to-end isolation through two independent servers.
    const a = await connectClient(ctx1);
    const b = await connectClient(ctx2);
    try {
      const credsA = await callCheckCredentials(a.client);
      const credsB = await callCheckCredentials(b.client);
      check(
        credsA.vercel === true && credsA.neon === false,
        `subject-1 server: vercel only (got ${JSON.stringify(credsA.configured)})`,
      );
      check(
        credsB.neon === true && credsB.vercel === false,
        `subject-2 server: neon only (got ${JSON.stringify(credsB.configured)})`,
      );
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  } finally {
    restoreEnv(saved);
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testCtxWinsOverEnv();
  await testNoCtxReadsEnv();
  await testCreateServerForwardsCtx();
  await testSubjectIsolation();
  process.stdout.write(`\nm9.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm9.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
