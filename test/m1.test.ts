/**
 * m1.test.ts - offline tests for the M1 deploy layer.
 *
 * Everything runs through installVercelMock() (a fake globalThis.fetch for
 * api.vercel.com) so the suite is 100% offline. Two levels are covered:
 *
 *   Adapter level (VercelAdapter against the mock):
 *     - createProject POSTs /v10/projects with an Authorization: Bearer header
 *       and a { name, framework } body; returns targetId "prj_123".
 *     - setEnvVars POSTs an ARRAY to /v10/projects/prj_123/env?upsert=true and
 *       returns setCount === vars.length.
 *     - deploy computes the CORRECT lowercase-hex sha1 of each file's bytes
 *       (asserted against the known node:crypto sha1 of a fixed string), uploads
 *       each file to /v2/files with x-vercel-digest === that sha1, then POSTs
 *       /v13/deployments whose files[].sha match; returns deploymentId "dpl_456",
 *       an "https://..." url, and status "building".
 *     - getLogs GETs /v3/deployments/dpl_456/events and returns the joined text.
 *     - teamId is appended to the query of every request when configured.
 *
 *   Tool level (in-memory MCP Client, dummy VERCEL_TOKEN, fetch mocked):
 *     - all 4 tools called; structuredContent asserted.
 *     - provider:"openai" (non-vercel) -> errors (isError result or rejection).
 *     - missing VERCEL_TOKEN -> isError.
 *
 * Wired to `npm run test:m1` (tsx test/m1.test.ts). Prints PASS/FAIL per check
 * and exits non-zero on the first failure.
 */
import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { VercelAdapter } from "../src/adapters/deploy/vercel/index.js";
import {
  CreateDeployTargetOutputSchema,
  SetEnvVarsOutputSchema,
  DeployOutputSchema,
  GetDeployLogsOutputSchema,
  type CreateDeployTargetOutput,
  type SetEnvVarsOutput,
  type DeployOutput,
  type GetDeployLogsOutput,
} from "../src/schemas.js";
import { installVercelMock, type RecordedCall } from "./vercel-mock.js";

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

/** All recorded calls whose URL pathname matches the predicate, in order. */
function filterCalls(
  calls: RecordedCall[],
  pred: (c: RecordedCall, path: string) => boolean,
): RecordedCall[] {
  return calls.filter((c) => pred(c, new URL(c.url).pathname));
}

/** Case-insensitive header lookup (fetch headers normalise to lowercase). */
function header(c: RecordedCall, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(c.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/* The fixed file the deploy test pins the sha1 of. The sha1 below is the literal
 * output of `crypto.createHash("sha1").update(Buffer.from(FIXED_CONTENT,"utf8"))`
 * and is hard-coded so the test catches any drift in the implementation's
 * hashing (algorithm, encoding, or casing). */
const FIXED_CONTENT = 'console.log("hello beam me up");\n';
const KNOWN_SHA1 = "1b7c84965b886f5389f858e2c761d12dda4d500c";

/* ------------------------------------------------------------------ */
/* Adapter-level tests                                                  */
/* ------------------------------------------------------------------ */

async function testAdapter(): Promise<void> {
  process.stdout.write("\n[adapter] VercelAdapter against vercel-mock\n");

  // Sanity: our hard-coded KNOWN_SHA1 really is node:crypto's sha1 of the fixed
  // string. If this drifts the whole sha1 chain below is meaningless.
  const liveSha1 = createHash("sha1")
    .update(Buffer.from(FIXED_CONTENT, "utf8"))
    .digest("hex");
  check(
    liveSha1 === KNOWN_SHA1,
    `known sha1 of fixed string === node:crypto sha1 (${KNOWN_SHA1})`,
  );

  const mock = installVercelMock();
  try {
    const adapter = new VercelAdapter({ token: "dummy-token" });

    /* ---- createProject -------------------------------------------- */
    const created = await adapter.createProject({
      name: "chatify",
      framework: "next",
    });
    check(
      created.targetId === "prj_123",
      `createProject returns targetId "prj_123" (got "${created.targetId}")`,
    );
    check(
      typeof created.dashboardUrl === "string" && created.dashboardUrl.length > 0,
      "createProject returns a non-empty dashboardUrl",
    );

    const projCall = findCall(mock.calls, (c, p) => c.method === "POST" && p === "/v10/projects");
    check(projCall !== undefined, "createProject POSTs /v10/projects");
    if (projCall) {
      check(
        header(projCall, "authorization") === "Bearer dummy-token",
        "createProject sends Authorization: Bearer <token>",
      );
      const b = projCall.body as { name?: unknown; framework?: unknown } | undefined;
      check(
        b !== undefined && b.name === "chatify" && b.framework === "next",
        `createProject body carries { name, framework } (got ${JSON.stringify(b)})`,
      );
    }

    /* ---- setEnvVars ----------------------------------------------- */
    const vars = [
      { key: "DATABASE_URL", value: "postgres://x", secret: true },
      { key: "PUBLIC_FLAG", value: "1" },
    ];
    const envRes = await adapter.setEnvVars({ targetId: "prj_123", vars });
    check(
      envRes.setCount === vars.length,
      `setEnvVars returns setCount === vars.length (${vars.length}, got ${envRes.setCount})`,
    );
    check(
      envRes.applied.includes("DATABASE_URL") && envRes.applied.includes("PUBLIC_FLAG"),
      `setEnvVars.applied lists the keys set (got ${JSON.stringify(envRes.applied)})`,
    );

    const envCall = findCall(
      mock.calls,
      (c, p) => c.method === "POST" && /^\/v10\/projects\/prj_123\/env$/.test(p),
    );
    check(
      envCall !== undefined,
      "setEnvVars POSTs /v10/projects/prj_123/env",
    );
    if (envCall) {
      const u = new URL(envCall.url);
      check(
        u.searchParams.get("upsert") === "true",
        "setEnvVars uses ?upsert=true",
      );
      check(
        Array.isArray(envCall.body) && (envCall.body as unknown[]).length === vars.length,
        `setEnvVars body is an ARRAY of length ${vars.length} (got ${JSON.stringify(envCall.body)})`,
      );
      const arr = envCall.body as Array<{ key?: unknown; type?: unknown; target?: unknown }>;
      const dbEntry = arr.find((e) => e.key === "DATABASE_URL");
      check(
        dbEntry !== undefined && dbEntry.type === "sensitive",
        "setEnvVars maps a secret var to type:'sensitive'",
      );
      const flagEntry = arr.find((e) => e.key === "PUBLIC_FLAG");
      check(
        flagEntry !== undefined && flagEntry.type === "encrypted",
        "setEnvVars maps a non-secret var to type:'encrypted'",
      );
    }

    /* ---- deploy (two-phase sha upload) ---------------------------- */
    const deployRes = await adapter.deploy({
      targetId: "prj_123",
      projectName: "chatify",
      framework: "next",
      files: [{ path: "index.js", content: FIXED_CONTENT }],
    });
    check(
      deployRes.deploymentId === "dpl_456",
      `deploy returns deploymentId "dpl_456" (got "${deployRes.deploymentId}")`,
    );
    check(
      deployRes.url === "https://chatify-abc.vercel.app",
      `deploy returns the https url (got "${deployRes.url}")`,
    );
    check(
      deployRes.status === "building",
      `deploy maps readyState BUILDING -> status "building" (got "${deployRes.status}")`,
    );

    // phase 1: upload to /v2/files with the CORRECT sha1 digest header.
    const fileCalls = filterCalls(mock.calls, (c, p) => c.method === "POST" && p === "/v2/files");
    check(
      fileCalls.length === 1,
      `deploy uploads each file once to /v2/files (got ${fileCalls.length})`,
    );
    const fileCall = fileCalls[0];
    if (fileCall) {
      check(
        header(fileCall, "x-vercel-digest") === KNOWN_SHA1,
        `/v2/files x-vercel-digest === known sha1 ${KNOWN_SHA1} (got "${header(fileCall, "x-vercel-digest")}")`,
      );
      check(
        header(fileCall, "content-type") === "application/octet-stream",
        "/v2/files sent as application/octet-stream",
      );
      check(
        header(fileCall, "content-length") ===
          String(Buffer.byteLength(FIXED_CONTENT, "utf8")),
        "/v2/files Content-Length === byte length of the file",
      );
      check(
        fileCall.body instanceof Uint8Array &&
          Buffer.from(fileCall.body).toString("utf8") === FIXED_CONTENT,
        "/v2/files raw body is the file bytes",
      );
    }

    // phase 2: /v13/deployments body files[].sha match the same sha1.
    const depCall = findCall(mock.calls, (c, p) => c.method === "POST" && p === "/v13/deployments");
    check(depCall !== undefined, "deploy POSTs /v13/deployments");
    if (depCall) {
      const b = depCall.body as
        | { name?: unknown; project?: unknown; files?: unknown; target?: unknown }
        | undefined;
      check(
        b !== undefined && b.name === "chatify" && b.project === "prj_123",
        "deployment body carries name (projectName) + project (targetId)",
      );
      const files = (b?.files ?? []) as Array<{ file?: unknown; sha?: unknown; size?: unknown }>;
      check(files.length === 1, `deployment body lists 1 file (got ${files.length})`);
      const f0 = files[0];
      check(
        f0 !== undefined && f0.file === "index.js" && f0.sha === KNOWN_SHA1,
        `deployment files[0] { file:"index.js", sha:${KNOWN_SHA1} } (got ${JSON.stringify(f0)})`,
      );
      check(
        f0 !== undefined && f0.size === Buffer.byteLength(FIXED_CONTENT, "utf8"),
        "deployment files[0].size === byte length",
      );
    }

    /* ---- getLogs -------------------------------------------------- */
    const logs = await adapter.getLogs({ deploymentId: "dpl_456" });
    check(
      logs.logText.includes("Build completed"),
      `getLogs returns the joined events text (got "${logs.logText}")`,
    );
    const eventsCall = findCall(
      mock.calls,
      (c, p) => c.method === "GET" && /^\/v3\/deployments\/dpl_456\/events$/.test(p),
    );
    check(
      eventsCall !== undefined,
      "getLogs GETs /v3/deployments/dpl_456/events",
    );

    /* ---- network-escape guard: the happy path hit ONLY mocked --- */
    // Every adapter call above must have resolved to a canned api.vercel.com
    // response. A non-empty `blocked` list means the impl reached a non-vercel
    // host (real network) or an endpoint the mock never canned.
    check(
      mock.blocked.length === 0,
      `no real-network escape: 0 blocked/unmocked requests (got ${JSON.stringify(mock.blocked)})`,
    );
    // Belt-and-braces: assert every recorded URL targeted api.vercel.com.
    const offHost = mock.calls.filter((c) => new URL(c.url).host !== "api.vercel.com");
    check(
      offHost.length === 0,
      `every adapter request targeted api.vercel.com (${offHost.length} off-host)`,
    );
  } finally {
    mock.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Network-escape guard self-test: the mock REFUSES anything it never  */
/* canned, so a stray real call (wrong host or wrong path) fails loudly */
/* instead of silently hitting the network.                            */
/* ------------------------------------------------------------------ */

async function testNetworkEscapeGuard(): Promise<void> {
  process.stdout.write("\n[guard] mock refuses unmocked URLs (no real network)\n");
  const mock = installVercelMock();
  try {
    // A non-vercel host: a real-network escape attempt.
    const evil = await fetch("https://evil.example.com/steal");
    check(evil.status === 599, "non-vercel host is refused with a 599 (no real network)");
    check(
      mock.blocked.some((b) => b.reason === "non-vercel-host"),
      "non-vercel host is recorded as a blocked escape",
    );

    // A recognised host but an endpoint the mock never canned.
    const unmocked = await fetch("https://api.vercel.com/v99/does-not-exist", {
      method: "POST",
    });
    check(unmocked.status === 404, "unmocked api.vercel.com path returns a loud 404");
    check(
      mock.blocked.some((b) => b.reason === "unmocked-path"),
      "unmocked path is recorded as a blocked escape",
    );
  } finally {
    mock.restore();
  }
}

/* ------------------------------------------------------------------ */
/* teamId-appended test (separate adapter with teamId configured)      */
/* ------------------------------------------------------------------ */

async function testTeamId(): Promise<void> {
  process.stdout.write("\n[adapter] teamId appended to every request\n");
  const mock = installVercelMock();
  try {
    const adapter = new VercelAdapter({ token: "dummy-token", teamId: "team_xyz" });
    await adapter.createProject({ name: "chatify" });
    await adapter.deploy({
      targetId: "prj_123",
      projectName: "chatify",
      files: [{ path: "index.js", content: FIXED_CONTENT }],
    });

    check(mock.calls.length > 0, "teamId test recorded at least one call");
    const missing = mock.calls.filter(
      (c) => new URL(c.url).searchParams.get("teamId") !== "team_xyz",
    );
    check(
      missing.length === 0,
      `every request carries ?teamId=team_xyz (${missing.length} missing of ${mock.calls.length})`,
    );
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
  const client = new Client({ name: "beam-me-up-m1-test", version: "0.0.0" });
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
 * (e.g. input validation rejected a bad provider) or the handler returned an
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

async function testTools(): Promise<void> {
  process.stdout.write("\n[tools] in-memory MCP client (4 tools + error paths)\n");

  const savedToken = process.env.VERCEL_TOKEN;
  const savedTeam = process.env.VERCEL_TEAM_ID;
  process.env.VERCEL_TOKEN = "dummy-token";
  delete process.env.VERCEL_TEAM_ID;

  const mock = installVercelMock();
  const { client, close } = await connectClient();

  try {
    /* ---- listTools includes all 7 -------------------------------- */
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    for (const expected of [
      "create_deploy_target",
      "set_env_vars",
      "deploy",
      "get_deploy_logs",
    ]) {
      check(
        toolNames.includes(expected),
        `tool list includes "${expected}"`,
      );
    }

    /* ---- create_deploy_target ------------------------------------ */
    const cRes = await client.callTool({
      name: "create_deploy_target",
      arguments: { provider: "vercel", projectName: "chatify", framework: "next" },
    });
    check(!cRes.isError, `create_deploy_target ok (${firstText(cRes.content)})`);
    const cOut = CreateDeployTargetOutputSchema.parse(
      cRes.structuredContent,
    ) as CreateDeployTargetOutput;
    check(cOut.targetId === "prj_123", `create_deploy_target -> targetId "prj_123"`);
    check(cOut.provider === "vercel", `create_deploy_target -> provider "vercel"`);
    check(
      typeof cOut.dashboardUrl === "string" && cOut.dashboardUrl.length > 0,
      "create_deploy_target -> non-empty dashboardUrl",
    );

    /* ---- set_env_vars -------------------------------------------- */
    const eRes = await client.callTool({
      name: "set_env_vars",
      arguments: {
        provider: "vercel",
        targetId: "prj_123",
        vars: [
          { key: "DATABASE_URL", value: "postgres://x", secret: true },
          { key: "NEXTAUTH_SECRET", value: "s3cr3t", secret: true },
        ],
      },
    });
    check(!eRes.isError, `set_env_vars ok (${firstText(eRes.content)})`);
    const eOut = SetEnvVarsOutputSchema.parse(
      eRes.structuredContent,
    ) as SetEnvVarsOutput;
    check(eOut.setCount === 2, `set_env_vars -> setCount 2 (got ${eOut.setCount})`);
    check(
      eOut.applied.includes("DATABASE_URL") && eOut.applied.includes("NEXTAUTH_SECRET"),
      "set_env_vars -> applied lists both keys",
    );
    // Secret values must never be echoed in the result text.
    check(
      !(firstText(eRes.content) ?? "").includes("s3cr3t"),
      "set_env_vars result never echoes secret values",
    );

    /* ---- deploy -------------------------------------------------- */
    const dRes = await client.callTool({
      name: "deploy",
      arguments: {
        provider: "vercel",
        targetId: "prj_123",
        projectName: "chatify",
        framework: "next",
        files: [{ path: "index.js", content: FIXED_CONTENT }],
      },
    });
    check(!dRes.isError, `deploy ok (${firstText(dRes.content)})`);
    const dOut = DeployOutputSchema.parse(dRes.structuredContent) as DeployOutput;
    check(dOut.deploymentId === "dpl_456", `deploy -> deploymentId "dpl_456"`);
    check(
      dOut.url === "https://chatify-abc.vercel.app",
      `deploy -> https url (got "${dOut.url}")`,
    );
    check(dOut.status === "building", `deploy -> status "building" (got "${dOut.status}")`);

    /* ---- get_deploy_logs ----------------------------------------- */
    const gRes = await client.callTool({
      name: "get_deploy_logs",
      arguments: { provider: "vercel", deploymentId: "dpl_456", type: "build" },
    });
    check(!gRes.isError, `get_deploy_logs ok (${firstText(gRes.content)})`);
    const gOut = GetDeployLogsOutputSchema.parse(
      gRes.structuredContent,
    ) as GetDeployLogsOutput;
    check(
      gOut.logText.includes("Build completed"),
      `get_deploy_logs -> logText has build output (got "${gOut.logText}")`,
    );

    /* ---- wrong provider -> isError ------------------------------- */
    // The schema narrows provider to "vercel"; a non-vercel provider is rejected
    // either at the SDK input boundary (rejection) or by the handler (isError).
    const wrong = await callErrors(client, "create_deploy_target", {
      provider: "openai",
      projectName: "chatify",
    });
    check(
      wrong.errored,
      `create_deploy_target provider:"openai" -> error (got ${JSON.stringify(wrong.text)})`,
    );

    /* ---- missing token -> isError -------------------------------- */
    delete process.env.VERCEL_TOKEN;
    const noTok = await callErrors(client, "create_deploy_target", {
      provider: "vercel",
      projectName: "chatify",
    });
    check(noTok.errored, "create_deploy_target with no VERCEL_TOKEN -> isError");
    check(
      (noTok.text ?? "").toUpperCase().includes("VERCEL_TOKEN"),
      `missing-token error mentions VERCEL_TOKEN (got ${JSON.stringify(noTok.text)})`,
    );

    /* ---- network-escape guard for the tool path ----------------- */
    // The successful tool calls above must have stayed entirely on the mocked
    // api.vercel.com surface. (The two error cases short-circuit before fetch.)
    check(
      mock.blocked.length === 0,
      `tool path made no real-network escape (got ${JSON.stringify(mock.blocked)})`,
    );
  } finally {
    await close();
    mock.restore();
    // Restore env exactly as we found it.
    if (savedToken === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = savedToken;
    if (savedTeam === undefined) delete process.env.VERCEL_TEAM_ID;
    else process.env.VERCEL_TEAM_ID = savedTeam;
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await testNetworkEscapeGuard();
  await testAdapter();
  await testTeamId();
  await testTools();
  process.stdout.write(`\nm1.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm1.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
