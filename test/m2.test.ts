/**
 * m2.test.ts - offline tests for the M2 database provisioning layer.
 *
 * Everything runs through installDbMock() (a fake globalThis.fetch for
 * console.neon.tech + api.upstash.com) so the suite is 100% offline. Modeled on
 * test/m1.test.ts. Four levels are covered:
 *
 *   Network-escape guard (self-test): the mock refuses any non-(neon|upstash)
 *     host and any unmocked path, recording each as a blocked escape, and never
 *     touches the real network.
 *
 *   Adapter level (NeonProvisioner / UpstashProvisioner against the mock):
 *     - NeonProvisioner POSTs .../projects with an Authorization: Bearer header,
 *       then GETs .../connection_uri?pooled=true; envVars.DATABASE_URL contains
 *       "-pooler" and DATABASE_URL_UNPOOLED is the DIRECT connection_uri.
 *       resourceId === the project id; provider === "neon".
 *     - UpstashProvisioner POSTs .../redis/database with a correct Basic header
 *       (decode base64 -> "<email>:<apiKey>"); envVars has REDIS_URL
 *       "rediss://default:<password>@<endpoint>:<port>", UPSTASH_REDIS_REST_URL
 *       "https://<endpoint>", UPSTASH_REDIS_REST_TOKEN. resourceId === the
 *       database id; provider === "upstash".
 *
 *   Tool level (in-memory MCP Client, like src/smoke-test.ts):
 *     - listTools includes provision_database (+ the rest of the M0/M1/M2 tools).
 *     - NEON_API_KEY set + fetch mocked: provision_database
 *       {engine:"postgres",name:"db"} -> structuredContent has DATABASE_URL.
 *     - UPSTASH_EMAIL + UPSTASH_API_KEY set: engine:"redis" -> REDIS_URL.
 *     - missing creds -> isError naming the missing env var(s).
 *     - engine:"mysql" -> isError.
 *     - 0 escapes after the runs (no real-network reach).
 *
 * Wired to `npm run test:m2` (tsx test/m2.test.ts). Prints PASS/FAIL per check
 * and exits non-zero on the first failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "@beam-me-up/server";
import { NeonProvisioner } from "@beam-me-up/adapters";
import { UpstashProvisioner } from "@beam-me-up/adapters";
import {
  ProvisionDatabaseOutputSchema,
  type ProvisionDatabaseOutput,
} from "@beam-me-up/core";
import {
  installDbMock,
  type RecordedCall,
  NEON_PROJECT_ID,
  NEON_DIRECT_URI,
  UPSTASH_DATABASE_ID,
  UPSTASH_ENDPOINT,
  UPSTASH_PORT,
  UPSTASH_PASSWORD,
  UPSTASH_REST_TOKEN,
} from "./db-mock.js";

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

/** Pull the first text block out of a tool result's `content` array, if any. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first && first.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return undefined;
}

/** Find the (last) recorded call whose URL pathname matches the predicate. */
function findCall(
  calls: RecordedCall[],
  pred: (c: RecordedCall, path: string) => boolean,
): RecordedCall | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const c = calls[i];
    if (c === undefined) continue;
    const path = new URL(c.url).pathname;
    if (pred(c, path)) return c;
  }
  return undefined;
}

/** Case-insensitive header lookup (fetch headers normalise to lowercase). */
function header(c: RecordedCall, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(c.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Network-escape guard self-test: the mock REFUSES anything it never  */
/* canned, so a stray real call (wrong host or wrong path) fails loudly */
/* instead of silently hitting the network.                            */
/* ------------------------------------------------------------------ */

async function testNetworkEscapeGuard(): Promise<void> {
  process.stdout.write("\n[guard] mock refuses unmocked URLs (no real network)\n");
  const mock = installDbMock();
  try {
    // A non-(neon|upstash) host: a real-network escape attempt.
    const evil = await fetch("https://evil.example.com/steal");
    check(evil.status === 599, "non-db host is refused with a 599 (no real network)");
    check(
      mock.blocked.some((b) => b.reason === "non-db-host"),
      "non-db host is recorded as a blocked escape",
    );

    // A recognised host but an endpoint the mock never canned.
    const unmocked = await fetch("https://console.neon.tech/api/v2/does-not-exist", {
      method: "POST",
    });
    check(unmocked.status === 404, "unmocked Neon path returns a loud 404");
    check(
      mock.blocked.some((b) => b.reason === "unmocked-path"),
      "unmocked path is recorded as a blocked escape",
    );
  } finally {
    mock.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Adapter-level test: NeonProvisioner                                 */
/* ------------------------------------------------------------------ */

async function testNeonAdapter(): Promise<void> {
  process.stdout.write("\n[adapter] NeonProvisioner against db-mock\n");

  const mock = installDbMock();
  try {
    const provisioner = new NeonProvisioner({ apiKey: "neon-key-abc" });
    check(provisioner.provider === "neon", 'NeonProvisioner.provider === "neon"');

    const result = await provisioner.provision({ name: "chatify-db" });

    /* ---- result shape -------------------------------------------- */
    check(result.provider === "neon", `provision -> provider "neon" (got "${result.provider}")`);
    check(
      result.resourceId === NEON_PROJECT_ID,
      `provision -> resourceId === project.id "${NEON_PROJECT_ID}" (got "${result.resourceId}")`,
    );

    /* ---- envVars: pooled DATABASE_URL + direct UNPOOLED ---------- */
    check(
      typeof result.envVars.DATABASE_URL === "string" &&
        result.envVars.DATABASE_URL.includes("-pooler"),
      `DATABASE_URL is the POOLED uri (host contains "-pooler") (got "${result.envVars.DATABASE_URL}")`,
    );
    check(
      result.envVars.DATABASE_URL_UNPOOLED === NEON_DIRECT_URI,
      `DATABASE_URL_UNPOOLED is the DIRECT connection_uri (got "${result.envVars.DATABASE_URL_UNPOOLED}")`,
    );
    check(
      !result.envVars.DATABASE_URL_UNPOOLED.includes("-pooler"),
      "DATABASE_URL_UNPOOLED is NOT pooled (no -pooler)",
    );

    /* ---- POST .../projects with Bearer --------------------------- */
    const projCall = findCall(
      mock.calls,
      (c, p) => c.method === "POST" && /\/projects\/?$/.test(p),
    );
    check(projCall !== undefined, "NeonProvisioner POSTs .../projects");
    if (projCall) {
      check(
        header(projCall, "authorization") === "Bearer neon-key-abc",
        `create sends Authorization: Bearer <apiKey> (got "${header(projCall, "authorization")}")`,
      );
      check(
        new URL(projCall.url).host === "console.neon.tech",
        "create targets console.neon.tech",
      );
    }

    /* ---- GET .../connection_uri?pooled=true ---------------------- */
    const uriCall = findCall(
      mock.calls,
      (c, p) => c.method === "GET" && /\/projects\/[^/]+\/connection_uri\/?$/.test(p),
    );
    check(uriCall !== undefined, "NeonProvisioner GETs .../connection_uri");
    if (uriCall) {
      const q = new URL(uriCall.url).searchParams;
      check(
        q.get("pooled") === "true",
        `connection_uri request uses ?pooled=true (got "${q.get("pooled")}")`,
      );
      check(
        header(uriCall, "authorization") === "Bearer neon-key-abc",
        "connection_uri GET also sends the Bearer header",
      );
    }

    /* ---- no real-network escape ---------------------------------- */
    check(
      mock.blocked.length === 0,
      `no real-network escape (got ${JSON.stringify(mock.blocked)})`,
    );
    const offHost = mock.calls.filter(
      (c) => new URL(c.url).host !== "console.neon.tech",
    );
    check(offHost.length === 0, `every Neon request targeted console.neon.tech (${offHost.length} off-host)`);
  } finally {
    mock.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Idempotency: provision reuses an existing project by name           */
/* ------------------------------------------------------------------ */

async function testNeonDedup(): Promise<void> {
  process.stdout.write("\n[adapter] NeonProvisioner is idempotent by name\n");
  // Seed the account with a project of the same name -> provision must REUSE it
  // (no duplicate created).
  const mock = installDbMock({
    neonProjects: [{ id: NEON_PROJECT_ID, name: "chatify-db" }],
  });
  try {
    const provisioner = new NeonProvisioner({ apiKey: "neon-key-abc" });
    const result = await provisioner.provision({ name: "chatify-db" });

    check(
      result.resourceId === NEON_PROJECT_ID,
      `dedup -> reuses the existing project id "${NEON_PROJECT_ID}" (got "${result.resourceId}")`,
    );
    check(
      (result.envVars.DATABASE_URL ?? "").includes("-pooler"),
      "dedup -> still returns the pooled DATABASE_URL",
    );
    check(
      result.envVars.DATABASE_URL_UNPOOLED === NEON_DIRECT_URI,
      "dedup -> DATABASE_URL_UNPOOLED is the direct (unpooled) uri",
    );

    const posted = mock.calls.find(
      (c) => c.method === "POST" && /\/projects\/?$/.test(new URL(c.url).pathname),
    );
    check(posted === undefined, "dedup -> NO POST /projects (no duplicate created)");
    const listed = mock.calls.find(
      (c) => c.method === "GET" && /\/projects\/?$/.test(new URL(c.url).pathname),
    );
    check(listed !== undefined, "dedup -> GET /projects (looked the project up by name)");
    check(
      mock.blocked.length === 0,
      `dedup -> 0 blocked escapes (got ${JSON.stringify(mock.blocked)})`,
    );
  } finally {
    mock.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Adapter-level test: UpstashProvisioner                              */
/* ------------------------------------------------------------------ */

async function testUpstashAdapter(): Promise<void> {
  process.stdout.write("\n[adapter] UpstashProvisioner against db-mock\n");

  const EMAIL = "dev@example.com";
  const API_KEY = "upstash-key-xyz";

  const mock = installDbMock();
  try {
    const provisioner = new UpstashProvisioner({ email: EMAIL, apiKey: API_KEY });
    check(provisioner.provider === "upstash", 'UpstashProvisioner.provider === "upstash"');

    const result = await provisioner.provision({ name: "chatify-cache" });

    /* ---- result shape -------------------------------------------- */
    check(result.provider === "upstash", `provision -> provider "upstash" (got "${result.provider}")`);
    check(
      result.resourceId === UPSTASH_DATABASE_ID,
      `provision -> resourceId === database_id "${UPSTASH_DATABASE_ID}" (got "${result.resourceId}")`,
    );

    /* ---- envVars: REDIS_URL + REST url/token --------------------- */
    const expectedRedisUrl = `rediss://default:${UPSTASH_PASSWORD}@${UPSTASH_ENDPOINT}:${UPSTASH_PORT}`;
    check(
      result.envVars.REDIS_URL === expectedRedisUrl,
      `REDIS_URL === "rediss://default:<password>@<endpoint>:<port>" (got "${result.envVars.REDIS_URL}")`,
    );
    check(
      result.envVars.UPSTASH_REDIS_REST_URL === `https://${UPSTASH_ENDPOINT}`,
      `UPSTASH_REDIS_REST_URL === "https://<endpoint>" (got "${result.envVars.UPSTASH_REDIS_REST_URL}")`,
    );
    check(
      result.envVars.UPSTASH_REDIS_REST_TOKEN === UPSTASH_REST_TOKEN,
      `UPSTASH_REDIS_REST_TOKEN === the rest_token (got "${result.envVars.UPSTASH_REDIS_REST_TOKEN}")`,
    );

    /* ---- POST .../redis/database with a correct Basic header ----- */
    const createCall = findCall(
      mock.calls,
      (c, p) => c.method === "POST" && /\/redis\/database\/?$/.test(p),
    );
    check(createCall !== undefined, "UpstashProvisioner POSTs .../redis/database");
    if (createCall) {
      check(
        new URL(createCall.url).host === "api.upstash.com",
        "create targets api.upstash.com",
      );
      const auth = header(createCall, "authorization");
      check(
        typeof auth === "string" && auth.startsWith("Basic "),
        `create sends Authorization: Basic ... (got "${auth}")`,
      );
      if (typeof auth === "string" && auth.startsWith("Basic ")) {
        const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
        check(
          decoded === `${EMAIL}:${API_KEY}`,
          `Basic header decodes to "<email>:<apiKey>" (got "${decoded}")`,
        );
      }
      // Real Upstash Developer API: the create body uses `database_name`
      // (NOT the pinned `name`), `primary_region` (NOT `region`), and a
      // REQUIRED `platform`. Pin the real shape the adapter + mock agree on.
      const b = createCall.body as
        | {
            database_name?: unknown;
            primary_region?: unknown;
            platform?: unknown;
          }
        | undefined;
      check(
        b !== undefined && b.database_name === "chatify-cache",
        `create body carries { database_name } (got ${JSON.stringify(b)})`,
      );
      check(
        b !== undefined && b.primary_region === "us-east-1",
        `create body carries { primary_region } default (got ${JSON.stringify(b)})`,
      );
      check(
        b !== undefined && b.platform === "aws",
        `create body carries required { platform } (got ${JSON.stringify(b)})`,
      );
    }

    /* ---- no real-network escape ---------------------------------- */
    check(
      mock.blocked.length === 0,
      `no real-network escape (got ${JSON.stringify(mock.blocked)})`,
    );
    const offHost = mock.calls.filter(
      (c) => new URL(c.url).host !== "api.upstash.com",
    );
    check(offHost.length === 0, `every Upstash request targeted api.upstash.com (${offHost.length} off-host)`);
  } finally {
    mock.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Tool-level tests (in-memory MCP client)                             */
/* ------------------------------------------------------------------ */

/** Connect an in-memory MCP Client to a fresh server. */
async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer();
  const client = new Client({ name: "beam-me-up-m2-test", version: "0.0.0" });
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

/**
 * Returns true if a tool call "errored" - either the SDK rejected the call
 * (e.g. input validation rejected a bad engine) or the handler returned an
 * isError result.
 */
async function callErrors(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ errored: boolean; text: string | undefined }> {
  try {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) {
      return { errored: true, text: firstText(res.content) };
    }
    return { errored: false, text: firstText(res.content) };
  } catch (err) {
    return { errored: true, text: String(err) };
  }
}

/** Snapshot the M2 env vars so each test can set + restore them cleanly. */
function snapshotEnv(): Record<string, string | undefined> {
  return {
    NEON_API_KEY: process.env.NEON_API_KEY,
    UPSTASH_EMAIL: process.env.UPSTASH_EMAIL,
    UPSTASH_API_KEY: process.env.UPSTASH_API_KEY,
  };
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function testTools(): Promise<void> {
  process.stdout.write("\n[tools] in-memory MCP client (provision_database + error paths)\n");

  const saved = snapshotEnv();
  const mock = installDbMock();
  const { client, close } = await connectClient();

  try {
    /* ---- listTools includes the M0+M1+M2 tools ------------------- */
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    check(
      toolNames.includes("provision_database"),
      'tool list includes "provision_database"',
    );
    // Subset check (not an exact count) so later milestones can add tools
    // without breaking this assertion.
    const m2EraTools = [
      "route_target",
      "validate_compose",
      "write_todo",
      "create_deploy_target",
      "set_env_vars",
      "deploy",
      "get_deploy_logs",
      "provision_database",
    ];
    const missingTools = m2EraTools.filter((t) => !toolNames.includes(t));
    check(
      missingTools.length === 0,
      `all M0+M1+M2 tools registered (missing: ${JSON.stringify(missingTools)}; got ${toolNames.join(", ")})`,
    );

    /* ---- postgres (Neon) happy path ------------------------------ */
    process.env.NEON_API_KEY = "neon-key-abc";
    delete process.env.UPSTASH_EMAIL;
    delete process.env.UPSTASH_API_KEY;

    const pgRes = await client.callTool({
      name: "provision_database",
      arguments: { engine: "postgres", name: "chatify-db" },
    });
    check(!pgRes.isError, `provision_database postgres ok (${firstText(pgRes.content)})`);
    const pgOut = ProvisionDatabaseOutputSchema.parse(
      pgRes.structuredContent,
    ) as ProvisionDatabaseOutput;
    check(pgOut.provider === "neon", `postgres -> provider "neon" (got "${pgOut.provider}")`);
    check(
      pgOut.resourceId === NEON_PROJECT_ID,
      `postgres -> resourceId "${NEON_PROJECT_ID}" (got "${pgOut.resourceId}")`,
    );
    check(
      typeof pgOut.envVars.DATABASE_URL === "string" &&
        pgOut.envVars.DATABASE_URL.includes("-pooler"),
      `postgres -> envVars has a pooled DATABASE_URL (got "${pgOut.envVars.DATABASE_URL}")`,
    );

    /* ---- redis (Upstash) happy path ------------------------------ */
    delete process.env.NEON_API_KEY;
    process.env.UPSTASH_EMAIL = "dev@example.com";
    process.env.UPSTASH_API_KEY = "upstash-key-xyz";

    const rdRes = await client.callTool({
      name: "provision_database",
      arguments: { engine: "redis", name: "chatify-cache" },
    });
    check(!rdRes.isError, `provision_database redis ok (${firstText(rdRes.content)})`);
    const rdOut = ProvisionDatabaseOutputSchema.parse(
      rdRes.structuredContent,
    ) as ProvisionDatabaseOutput;
    check(rdOut.provider === "upstash", `redis -> provider "upstash" (got "${rdOut.provider}")`);
    check(
      rdOut.resourceId === UPSTASH_DATABASE_ID,
      `redis -> resourceId "${UPSTASH_DATABASE_ID}" (got "${rdOut.resourceId}")`,
    );
    check(
      typeof rdOut.envVars.REDIS_URL === "string" &&
        rdOut.envVars.REDIS_URL.startsWith("rediss://default:"),
      `redis -> envVars has a REDIS_URL "rediss://default:..." (got "${rdOut.envVars.REDIS_URL}")`,
    );
    // Secret material must never be echoed in the human-readable text? The tool
    // legitimately returns connection strings in structuredContent; we only
    // assert the structured value here (no secrecy claim for db connection env).

    /* ---- missing postgres creds -> isError naming NEON_API_KEY --- */
    delete process.env.NEON_API_KEY;
    delete process.env.UPSTASH_EMAIL;
    delete process.env.UPSTASH_API_KEY;
    const noNeon = await callErrors(client, "provision_database", {
      engine: "postgres",
      name: "db",
    });
    check(noNeon.errored, "postgres with no NEON_API_KEY -> isError");
    check(
      (noNeon.text ?? "").toUpperCase().includes("NEON_API_KEY"),
      `missing-creds error names NEON_API_KEY (got ${JSON.stringify(noNeon.text)})`,
    );

    /* ---- missing redis creds -> isError naming UPSTASH vars ------ */
    const noUpstash = await callErrors(client, "provision_database", {
      engine: "redis",
      name: "db",
    });
    check(noUpstash.errored, "redis with no UPSTASH creds -> isError");
    check(
      (noUpstash.text ?? "").toUpperCase().includes("UPSTASH"),
      `missing-creds error names the UPSTASH vars (got ${JSON.stringify(noUpstash.text)})`,
    );

    /* ---- unsupported engine -> isError --------------------------- */
    // The schema narrows engine to "postgres"|"redis"; "mysql" is rejected
    // either at the SDK input boundary (rejection) or by the handler (isError).
    const mysql = await callErrors(client, "provision_database", {
      engine: "mysql",
      name: "db",
    });
    check(
      mysql.errored,
      `engine:"mysql" -> error (got ${JSON.stringify(mysql.text)})`,
    );

    /* ---- network-escape guard for the tool path ----------------- */
    // The successful tool calls above must have stayed entirely on the mocked
    // Neon + Upstash surfaces. (The error cases short-circuit before fetch.)
    check(
      mock.blocked.length === 0,
      `tool path made no real-network escape (got ${JSON.stringify(mock.blocked)})`,
    );
    const offHost = mock.calls.filter((c) => {
      const h = new URL(c.url).host;
      return h !== "console.neon.tech" && h !== "api.upstash.com";
    });
    check(
      offHost.length === 0,
      `every tool-path request targeted Neon/Upstash (${offHost.length} off-host)`,
    );
  } finally {
    await close();
    mock.restore();
    restoreEnv(saved);
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testNetworkEscapeGuard();
  await testNeonAdapter();
  await testNeonDedup();
  await testUpstashAdapter();
  await testTools();
  process.stdout.write(`\nm2.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm2.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
