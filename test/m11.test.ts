/**
 * m11.test.ts - offline tests for M9 P2c: the per-user credential VAULT wired
 * into the live HTTP server, making credential resolution PER USER end to end.
 *
 * 100% offline (no network, no DB, no KMS): an InMemoryCredentialStore (from
 * @beam-me-up/vault, seeded via upsertConnection) is INJECTED into
 * createBeamHttpServer({ store }), OAuth is enabled with an HS256 test secret,
 * and the server is bound to an ephemeral loopback port. Tokens are minted
 * in-test with node:crypto (mirrors test/m5.test.ts). The MCP handshake runs
 * over the SDK's StreamableHTTPClientTransport carrying the bearer token.
 *
 * Covers:
 *   (a) STORE wins over env: env creds are BLANK, but an authenticated /mcp
 *       request resolves the subject's vault creds (observed via
 *       check_credentials).
 *   (b) SUB-REJECTION: a valid token WITHOUT a sub + a store active -> 401
 *       invalid_token (the vault is never keyed on a wildcard / clientId).
 *   (c) NO store configured -> behaviour UNCHANGED: an authenticated request
 *       still resolves from env creds.
 *   (d) ISOLATION: two different subjects (two tokens) resolve their OWN vault
 *       data and never see each other's.
 *
 * Wired to `npm run test:m11` (tsx test/m11.test.ts). Mirrors the tiny check()
 * harness in test/m5.test.ts / test/m10.test.ts.
 */
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createBeamHttpServer, resetVaultStoreForTests } from "@beam-me-up/server";
import {
  createInMemoryCredentialStore,
  type CredentialStore,
  type Subject,
} from "@beam-me-up/vault";

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
/* OAuth + token constants                                             */
/* ------------------------------------------------------------------ */

const ISSUER = "https://auth.example.com";
const AUDIENCE = "beam-me-up";
const HS256_SECRET = "test-hs256-secret-0123456789";
const RESOURCE_URL = "http://localhost:3000/mcp";
const NOW = 1_700_000_000;

/* ------------------------------------------------------------------ */
/* Token minting (node:crypto only, mirrors m5)                        */
/* ------------------------------------------------------------------ */

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function mintHs256(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = crypto
    .createHmac("sha256", HS256_SECRET)
    .update(signingInput)
    .digest()
    .toString("base64url");
  return `${signingInput}.${sig}`;
}

/** A valid token for `sub` (omit sub by passing null). */
function tokenFor(sub: string | null): string {
  const payload: Record<string, unknown> = {
    iss: ISSUER,
    aud: AUDIENCE,
    scope: "deploy",
    iat: NOW,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  if (sub !== null) payload.sub = sub;
  return mintHs256(payload);
}

/* ------------------------------------------------------------------ */
/* Env snapshot/restore (OAuth + provider creds + vault gate)          */
/* ------------------------------------------------------------------ */

const ENV_KEYS = [
  "OAUTH_ISSUER",
  "OAUTH_AUDIENCE",
  "OAUTH_JWT_SECRET",
  "OAUTH_JWT_PUBLIC_KEY",
  "OAUTH_JWT_ALG",
  "OAUTH_JWKS_URI",
  "OAUTH_RESOURCE_URL",
  "OAUTH_REQUIRED_SCOPES",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "DIGITALOCEAN_TOKEN",
  "NEON_API_KEY",
  "UPSTASH_EMAIL",
  "UPSTASH_API_KEY",
  "BEAM_VAULT_DATABASE_URL",
  "BEAM_KEK_LOCAL_SECRET",
  "BEAM_KEK_PROVIDER",
  "BEAM_TIER",
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
/** Enable OAuth (HS256) WITHOUT a vault DB url (store comes from injection). */
function enableOAuth(): void {
  process.env.OAUTH_ISSUER = ISSUER;
  process.env.OAUTH_AUDIENCE = AUDIENCE;
  process.env.OAUTH_JWT_SECRET = HS256_SECRET;
  process.env.OAUTH_RESOURCE_URL = RESOURCE_URL;
  process.env.OAUTH_REQUIRED_SCOPES = "";
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not read ephemeral port"));
        return;
      }
      resolve(addr.port);
    });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

type CredsResult = {
  vercel: boolean;
  digitalocean: boolean;
  neon: boolean;
  upstash: boolean;
  configured: string[];
  missing: string[];
};

/**
 * Run a full MCP handshake over HTTP carrying `token`, call check_credentials,
 * and return its structured result. Throws if the connection is rejected.
 */
async function checkCredentialsOverHttp(
  port: number,
  token: string,
): Promise<CredsResult> {
  const client = new Client({ name: "m11-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "check_credentials", arguments: {} });
    check(!res.isError, "check_credentials returns a non-error result");
    return res.structuredContent as CredsResult;
  } finally {
    await client.close();
  }
}

/** Raw initialize POST (no MCP handshake), returns the HTTP status. */
async function initializeStatus(port: number, token: string): Promise<number> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "m11", version: "0" },
    },
  });
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const status = res.status;
  await res.text();
  return status;
}

/* ------------------------------------------------------------------ */
/* Store seeding helpers                                               */
/* ------------------------------------------------------------------ */

function subjectOf(sub: string): Subject {
  return { issuer: ISSUER, sub };
}

async function seedVercel(store: CredentialStore, sub: string, token: string): Promise<void> {
  await store.upsertConnection({
    subject: subjectOf(sub),
    provider: "vercel",
    scopes: ["deploy"],
    accessToken: token,
  });
}
async function seedNeon(store: CredentialStore, sub: string, key: string): Promise<void> {
  await store.upsertConnection({
    subject: subjectOf(sub),
    provider: "neon",
    scopes: [],
    accessToken: key,
  });
}

/* ================================================================== */
/* (a) STORE wins over env (env blank)                                */
/* ================================================================== */

async function testStoreWinsOverEnv(): Promise<void> {
  process.stdout.write("\n[a] authenticated request resolves creds from the STORE, not env\n");

  const saved = snapshotEnv();
  try {
    clearEnv();
    enableOAuth(); // OAuth on, NO BEAM_VAULT_DATABASE_URL (store injected)

    // Provider env is BLANK: if the store were ignored, every provider is false.
    const store = createInMemoryCredentialStore();
    await seedVercel(store, "alice", "alice-vercel-tok");
    await seedNeon(store, "alice", "alice-neon-key");

    const server = createBeamHttpServer({ store });
    try {
      const port = await listenEphemeral(server);
      const creds = await checkCredentialsOverHttp(port, tokenFor("alice"));
      check(creds.vercel === true, "store exposes vercel -> check_credentials.vercel true (env blank)");
      check(creds.neon === true, "store exposes neon -> check_credentials.neon true (env blank)");
      check(creds.digitalocean === false, "store has no digitalocean -> false");
      check(creds.upstash === false, "store has no upstash -> false");
    } finally {
      await closeServer(server);
    }
  } finally {
    restoreEnv(saved);
  }
}

/* ================================================================== */
/* (b) SUB-REJECTION: token without sub + store active -> 401         */
/* ================================================================== */

async function testSubRejection(): Promise<void> {
  process.stdout.write("\n[b] a valid token WITHOUT sub + store active -> 401 invalid_token\n");

  const saved = snapshotEnv();
  try {
    clearEnv();
    enableOAuth();
    const store = createInMemoryCredentialStore();

    const server = createBeamHttpServer({ store });
    try {
      const port = await listenEphemeral(server);

      // No-sub token on the vault path -> 401 (vault never keys on a wildcard).
      const noSubStatus = await initializeStatus(port, tokenFor(null));
      check(noSubStatus === 401, `no-sub token + store active -> 401 (got ${noSubStatus})`);

      // Control: the SAME server accepts a token WITH a sub (not 401/403).
      const okStatus = await initializeStatus(port, tokenFor("bob"));
      check(
        okStatus !== 401 && okStatus !== 403,
        `a token WITH a sub is accepted on the vault path (got ${okStatus})`,
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    restoreEnv(saved);
  }
}

/* ================================================================== */
/* (c) NO store -> behaviour UNCHANGED (env creds)                    */
/* ================================================================== */

async function testNoStoreUsesEnv(): Promise<void> {
  process.stdout.write("\n[c] NO store configured -> authenticated request still resolves env creds\n");

  const saved = snapshotEnv();
  try {
    clearEnv();
    enableOAuth();
    // No store injected, no BEAM_VAULT_DATABASE_URL -> resolveVaultStore() null.
    // Env creds ARE set: the request must see them (behaviour unchanged).
    process.env.VERCEL_TOKEN = "env-vercel";
    process.env.NEON_API_KEY = "env-neon";

    const server = createBeamHttpServer(); // no store
    try {
      const port = await listenEphemeral(server);
      const creds = await checkCredentialsOverHttp(port, tokenFor("carol"));
      check(creds.vercel === true, "no store: env VERCEL_TOKEN -> vercel true");
      check(creds.neon === true, "no store: env NEON_API_KEY -> neon true");
      check(creds.digitalocean === false, "no store: digitalocean env unset -> false");
      check(creds.upstash === false, "no store: upstash env unset -> false");
    } finally {
      await closeServer(server);
    }
  } finally {
    restoreEnv(saved);
  }
}

/* ================================================================== */
/* (d) ISOLATION: two subjects resolve their OWN vault data           */
/* ================================================================== */

async function testIsolation(): Promise<void> {
  process.stdout.write("\n[d] two subjects (two tokens) resolve ISOLATED store data\n");

  const saved = snapshotEnv();
  try {
    clearEnv();
    enableOAuth();

    // alice connected vercel only; dave connected neon only.
    const store = createInMemoryCredentialStore();
    await seedVercel(store, "alice", "alice-vercel");
    await seedNeon(store, "dave", "dave-neon");

    const server = createBeamHttpServer({ store });
    try {
      const port = await listenEphemeral(server);

      const aliceCreds = await checkCredentialsOverHttp(port, tokenFor("alice"));
      check(
        aliceCreds.vercel === true && aliceCreds.neon === false,
        `alice sees vercel only (got ${JSON.stringify(aliceCreds.configured)})`,
      );

      const daveCreds = await checkCredentialsOverHttp(port, tokenFor("dave"));
      check(
        daveCreds.neon === true && daveCreds.vercel === false,
        `dave sees neon only (got ${JSON.stringify(daveCreds.configured)})`,
      );

      // A subject with NO connections sees nothing (isolation, not a leak).
      const eveCreds = await checkCredentialsOverHttp(port, tokenFor("eve"));
      check(
        !eveCreds.vercel && !eveCreds.neon && !eveCreds.digitalocean && !eveCreds.upstash,
        `unconnected subject sees nothing (got ${JSON.stringify(eveCreds.configured)})`,
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    restoreEnv(saved);
  }
}

/* ================================================================== */
/* (e) vault store BUILD failure (active vault) -> fail-closed 503     */
/* ================================================================== */

async function testVaultBuildFailureIs503(): Promise<void> {
  process.stdout.write("\n[e] vault store BUILD failure (active vault) -> 503, no env fallback, no hang\n");

  const saved = snapshotEnv();
  try {
    clearEnv();
    enableOAuth();
    // The vault is ACTIVE (db url set) but its KEK is missing, so the store build
    // (buildKekProvider) throws. Env provider creds are ALSO set: a wrong env
    // fallback would surface them — the correct behaviour is a fail-closed 503.
    process.env.BEAM_VAULT_DATABASE_URL = "postgres://dummy/db";
    delete process.env.BEAM_KEK_LOCAL_SECRET; // local-dev KEK has no secret -> build throws
    process.env.VERCEL_TOKEN = "env-vercel-must-not-leak";

    resetVaultStoreForTests(); // drop any store cached by an earlier test

    const server = createBeamHttpServer(); // NO injected store -> resolveVaultStore() from env
    try {
      const port = await listenEphemeral(server);

      // A build failure must NOT hang the request or fall back to env creds.
      const status1 = await initializeStatus(port, tokenFor("alice"));
      check(status1 === 503, `vault build failure -> fail-closed 503 (not env creds, not a hang) (got ${status1})`);

      // And the rejected build must not poison the path: a repeat is still a clean 503.
      const status2 = await initializeStatus(port, tokenFor("alice"));
      check(status2 === 503, `repeat after a build failure is still a clean 503 (got ${status2})`);
    } finally {
      await closeServer(server);
      resetVaultStoreForTests();
    }
  } finally {
    restoreEnv(saved);
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testStoreWinsOverEnv();
  await testSubRejection();
  await testNoStoreUsesEnv();
  await testIsolation();
  await testVaultBuildFailureIs503();
  process.stdout.write(`\nm11.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm11.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
