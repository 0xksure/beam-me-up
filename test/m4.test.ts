/**
 * m4.test.ts - offline tests for the M4 DigitalOcean App Platform deploy layer.
 *
 * Everything runs through installDigitalOceanMock() (a fake globalThis.fetch for
 * api.digitalocean.com) so the suite is 100% offline. Modeled on test/m1.test.ts
 * and test/m2.test.ts. Levels:
 *
 *   Pure helpers (src/adapters/deploy/digitalocean/app-spec.ts), no mock needed:
 *     - parseImageRef: DOCR (registry empty), Docker Hub (registry=org), GHCR,
 *       bare official ("nginx:alpine" -> library/nginx), default tag "latest",
 *       and an unsupported host (gcr.io) THROWS.
 *     - mapPhase: PENDING_BUILD->queued, BUILDING->building, ACTIVE->ready,
 *       ERROR->error, SUPERSEDED->canceled.
 *     - encode/decodeDeploymentId round-trip ("app_do_123:dep_do_2").
 *
 *   Adapter level (DigitalOceanAdapter against the mock):
 *     - createProject GETs /v2/apps then POSTs /v2/apps with an
 *       Authorization: Bearer header; returns targetId "app_do_123".
 *     - setEnvVars GETs then PUTs /v2/apps/app_do_123; the PUT body's
 *       services[0].envs upserts the key (secret -> type "SECRET"); returns
 *       setCount/applied.
 *     - deploy GETs then PUTs the app with services[0].image replaced (parsed
 *       from the ref); returns deploymentId "app_do_123:dep_do_2", an https url,
 *       and a mapped status.
 *     - getLogs GETs the deployment + the logs endpoint, fetches the historic
 *       URL, and returns logText including "Build completed"; status "ready".
 *
 *   Tool level (in-memory MCP client, DIGITALOCEAN_TOKEN set, fetch mocked):
 *     - create_deploy_target / set_env_vars / deploy / get_deploy_logs for
 *       provider "digitalocean"; structuredContent asserted.
 *     - deploy with no `image` -> isError ("DigitalOcean deploys need a
 *       container image").
 *     - missing DIGITALOCEAN_TOKEN -> isError naming DIGITALOCEAN_TOKEN.
 *     - a secret env value is never echoed in the result text.
 *     - 0 blocked escapes after the runs (everything stayed on the mock).
 *
 * Wired to `npm run test:m4` (tsx test/m4.test.ts). Prints PASS/FAIL per check
 * and exits non-zero on the first failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "@beam-me-up/server";
import { DigitalOceanAdapter } from "@beam-me-up/adapters";
import {
  decodeDeploymentId,
  encodeDeploymentId,
  mapPhase,
  parseImageRef,
} from "@beam-me-up/adapters";
import {
  CreateDeployTargetOutputSchema,
  type CreateDeployTargetOutput,
  SetEnvVarsOutputSchema,
  type SetEnvVarsOutput,
  DeployOutputSchema,
  type DeployOutput,
  GetDeployLogsOutputSchema,
  type GetDeployLogsOutput,
} from "@beam-me-up/core";
import {
  installDigitalOceanMock,
  type RecordedCall,
  APP_ID,
  DEPLOYMENT_ID,
  LIVE_URL,
} from "./digitalocean-mock.js";

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

/**
 * Reach into a captured PUT/POST body's spec.services[0] (the single service
 * the adapter writes the image + envs into). Returns undefined when the shape
 * is not what we expect, so the assertions fail loudly rather than throw.
 */
function firstService(
  body: unknown,
): { image?: unknown; envs?: unknown } | undefined {
  if (!body || typeof body !== "object" || !("spec" in body)) return undefined;
  const spec = (body as { spec?: unknown }).spec;
  if (!spec || typeof spec !== "object" || !("services" in spec)) return undefined;
  const services = (spec as { services?: unknown }).services;
  if (!Array.isArray(services)) return undefined;
  const svc = services[0];
  if (!svc || typeof svc !== "object") return undefined;
  return svc as { image?: unknown; envs?: unknown };
}

/* ------------------------------------------------------------------ */
/* Network-escape guard self-test: the mock REFUSES anything it never  */
/* canned, so a stray real call (wrong host or wrong path) fails loudly */
/* instead of silently hitting the network.                            */
/* ------------------------------------------------------------------ */

async function testNetworkEscapeGuard(): Promise<void> {
  process.stdout.write("\n[guard] mock refuses unmocked URLs (no real network)\n");
  const mock = installDigitalOceanMock();
  try {
    // A non-DigitalOcean host: a real-network escape attempt.
    const evil = await fetch("https://evil.example.com/steal");
    check(evil.status === 599, "non-do host is refused with a 599 (no real network)");
    check(
      mock.blocked.some((b) => b.reason === "non-do-host"),
      "non-do host is recorded as a blocked escape",
    );

    // A recognised host but an endpoint the mock never canned.
    const unmocked = await fetch("https://api.digitalocean.com/v2/does-not-exist", {
      method: "POST",
    });
    check(unmocked.status === 404, "unmocked DigitalOcean path returns a loud 404");
    check(
      mock.blocked.some((b) => b.reason === "unmocked-path"),
      "unmocked path is recorded as a blocked escape",
    );
  } finally {
    mock.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Pure-helper tests (app-spec.ts) - no mock needed                    */
/* ------------------------------------------------------------------ */

function testPureHelpers(): void {
  process.stdout.write("\n[pure] app-spec.ts (parseImageRef / mapPhase / id codec)\n");

  /* ---- parseImageRef: DOCR (registry dropped) ------------------- */
  const docr = parseImageRef("registry.digitalocean.com/myreg/web:1.2.3");
  check(
    docr.registry_type === "DOCR",
    `DOCR ref -> registry_type "DOCR" (got "${docr.registry_type}")`,
  );
  check(
    docr.repository === "web",
    `DOCR ref -> repository "web" (got "${docr.repository}")`,
  );
  check(
    docr.registry === undefined || docr.registry === "",
    `DOCR ref -> registry empty (DO infers it) (got "${docr.registry}")`,
  );
  check(docr.tag === "1.2.3", `DOCR ref -> tag "1.2.3" (got "${docr.tag}")`);

  /* ---- parseImageRef: Docker Hub (registry = org) --------------- */
  const dh = parseImageRef("docker.io/acme/web:1.2.3");
  check(
    dh.registry_type === "DOCKER_HUB",
    `docker.io ref -> registry_type "DOCKER_HUB" (got "${dh.registry_type}")`,
  );
  check(
    dh.registry === "acme",
    `docker.io ref -> registry "acme" (got "${dh.registry}")`,
  );
  check(
    dh.repository === "web",
    `docker.io ref -> repository "web" (got "${dh.repository}")`,
  );

  /* ---- parseImageRef: bare official image ----------------------- */
  const lib = parseImageRef("nginx:alpine");
  check(
    lib.registry_type === "DOCKER_HUB",
    `bare official ref -> registry_type "DOCKER_HUB" (got "${lib.registry_type}")`,
  );
  check(
    lib.registry === "library",
    `bare official ref -> registry "library" (got "${lib.registry}")`,
  );
  check(
    lib.repository === "nginx" && lib.tag === "alpine",
    `bare official ref -> repository "nginx" tag "alpine" (got "${lib.repository}":"${lib.tag}")`,
  );

  /* ---- parseImageRef: GHCR + default tag "latest" --------------- */
  const ghcr = parseImageRef("ghcr.io/acme/web");
  check(
    ghcr.registry_type === "GHCR",
    `ghcr.io ref -> registry_type "GHCR" (got "${ghcr.registry_type}")`,
  );
  check(
    ghcr.registry === "acme" && ghcr.repository === "web",
    `ghcr.io ref -> registry "acme" repository "web" (got "${ghcr.registry}"/"${ghcr.repository}")`,
  );
  check(
    ghcr.tag === "latest",
    `ghcr.io ref with no tag -> tag defaults to "latest" (got "${ghcr.tag}")`,
  );

  /* ---- parseImageRef: unsupported host THROWS ------------------- */
  let threw = false;
  try {
    parseImageRef("gcr.io/x/y:1");
  } catch {
    threw = true;
  }
  check(threw, "parseImageRef throws on an unsupported host (gcr.io)");

  /* ---- mapPhase ------------------------------------------------- */
  check(
    mapPhase("PENDING_BUILD") === "queued",
    `mapPhase("PENDING_BUILD") === "queued" (got "${mapPhase("PENDING_BUILD")}")`,
  );
  check(
    mapPhase("BUILDING") === "building",
    `mapPhase("BUILDING") === "building" (got "${mapPhase("BUILDING")}")`,
  );
  check(
    mapPhase("ACTIVE") === "ready",
    `mapPhase("ACTIVE") === "ready" (got "${mapPhase("ACTIVE")}")`,
  );
  check(
    mapPhase("ERROR") === "error",
    `mapPhase("ERROR") === "error" (got "${mapPhase("ERROR")}")`,
  );
  check(
    mapPhase("SUPERSEDED") === "canceled",
    `mapPhase("SUPERSEDED") === "canceled" (got "${mapPhase("SUPERSEDED")}")`,
  );

  /* ---- encode/decodeDeploymentId round-trip --------------------- */
  const encoded = encodeDeploymentId(APP_ID, DEPLOYMENT_ID);
  check(
    encoded === `${APP_ID}:${DEPLOYMENT_ID}`,
    `encodeDeploymentId -> "<appId>:<depId>" (got "${encoded}")`,
  );
  const decoded = decodeDeploymentId(encoded);
  check(
    decoded.appId === APP_ID && decoded.deploymentId === DEPLOYMENT_ID,
    `decodeDeploymentId round-trips (got ${JSON.stringify(decoded)})`,
  );
}

/* ------------------------------------------------------------------ */
/* Adapter-level test: DigitalOceanAdapter                             */
/* ------------------------------------------------------------------ */

async function testAdapter(): Promise<void> {
  process.stdout.write("\n[adapter] DigitalOceanAdapter against digitalocean-mock\n");

  const mock = installDigitalOceanMock();
  try {
    const adapter = new DigitalOceanAdapter({ token: "do-token" });
    check(adapter.id === "digitalocean", 'DigitalOceanAdapter.id === "digitalocean"');

    /* ---- createProject: GET /v2/apps then POST /v2/apps ---------- */
    const created = await adapter.createProject({ name: "web-app" });
    check(
      created.targetId === APP_ID,
      `createProject -> targetId "${APP_ID}" (got "${created.targetId}")`,
    );
    check(
      created.dashboardUrl === `https://cloud.digitalocean.com/apps/${APP_ID}`,
      `createProject -> dashboardUrl points at the app (got "${created.dashboardUrl}")`,
    );

    const listCall = findCall(
      mock.calls,
      (c, p) => c.method === "GET" && p === "/v2/apps",
    );
    check(listCall !== undefined, "createProject GETs /v2/apps (idempotency lookup)");

    const postCall = findCall(
      mock.calls,
      (c, p) => c.method === "POST" && p === "/v2/apps",
    );
    check(postCall !== undefined, "createProject POSTs /v2/apps (no existing app)");
    if (postCall) {
      check(
        header(postCall, "authorization") === "Bearer do-token",
        `create sends Authorization: Bearer <token> (got "${header(postCall, "authorization")}")`,
      );
      check(
        new URL(postCall.url).host === "api.digitalocean.com",
        "create targets api.digitalocean.com",
      );
    }

    /* ---- setEnvVars: GET then PUT, secret -> SECRET -------------- */
    const envResult = await adapter.setEnvVars({
      targetId: APP_ID,
      vars: [{ key: "DATABASE_URL", value: "postgres://x", secret: true }],
    });
    check(
      envResult.setCount === 1,
      `setEnvVars -> setCount 1 (got ${envResult.setCount})`,
    );
    check(
      JSON.stringify(envResult.applied) === JSON.stringify(["DATABASE_URL"]),
      `setEnvVars -> applied ["DATABASE_URL"] (got ${JSON.stringify(envResult.applied)})`,
    );

    const envPut = findCall(
      mock.calls,
      (c, p) => c.method === "PUT" && p === `/v2/apps/${APP_ID}`,
    );
    check(envPut !== undefined, "setEnvVars PUTs /v2/apps/app_do_123");
    if (envPut) {
      const svc = firstService(envPut.body);
      const envs = (svc?.envs ?? []) as { key?: unknown; type?: unknown }[];
      const dbVar = envs.find((e) => e.key === "DATABASE_URL");
      check(
        dbVar !== undefined,
        `PUT body.spec.services[0].envs has DATABASE_URL (got ${JSON.stringify(envs)})`,
      );
      check(
        dbVar?.type === "SECRET",
        `the secret var maps to type "SECRET" (got "${dbVar?.type}")`,
      );
    }

    /* ---- deploy: GET then PUT, DOCR image, encoded id ------------ */
    const deployResult = await adapter.deploy({
      targetId: APP_ID,
      projectName: "web-app",
      image: "registry.digitalocean.com/myreg/web:1.2.3",
    });
    check(
      deployResult.deploymentId === `${APP_ID}:${DEPLOYMENT_ID}`,
      `deploy -> deploymentId "${APP_ID}:${DEPLOYMENT_ID}" (got "${deployResult.deploymentId}")`,
    );
    check(
      deployResult.url === LIVE_URL,
      `deploy -> url "${LIVE_URL}" (got "${deployResult.url}")`,
    );
    check(
      deployResult.status === "building",
      `deploy -> status "building" (from pending phase BUILDING) (got "${deployResult.status}")`,
    );

    // The most recent PUT (deploy's) must carry the DOCR image source.
    const deployPut = findCall(
      mock.calls,
      (c, p) => c.method === "PUT" && p === `/v2/apps/${APP_ID}`,
    );
    check(deployPut !== undefined, "deploy PUTs /v2/apps/app_do_123 with the new image");
    if (deployPut) {
      const svc = firstService(deployPut.body);
      const image = svc?.image as { registry_type?: unknown; repository?: unknown } | undefined;
      check(
        image?.registry_type === "DOCR",
        `deploy PUT body image.registry_type "DOCR" (got "${image?.registry_type}")`,
      );
      check(
        image?.repository === "web",
        `deploy PUT body image.repository "web" (got "${image?.repository}")`,
      );
    }

    /* ---- getLogs: deployment status + historic log text --------- */
    const logs = await adapter.getLogs({
      deploymentId: `${APP_ID}:${DEPLOYMENT_ID}`,
    });
    check(
      logs.status === "ready",
      `getLogs -> status "ready" (deployment phase ACTIVE) (got "${logs.status}")`,
    );
    check(
      logs.logText.includes("Build completed"),
      `getLogs -> logText includes "Build completed" (got "${logs.logText}")`,
    );

    /* ---- no real-network escape --------------------------------- */
    check(
      mock.blocked.length === 0,
      `no real-network escape (got ${JSON.stringify(mock.blocked)})`,
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
  const client = new Client({ name: "beam-me-up-m4-test", version: "0.0.0" });
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
 * (e.g. input validation) or the handler returned an isError result.
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

/** Snapshot the M4 env var so each test can set + restore it cleanly. */
function snapshotEnv(): Record<string, string | undefined> {
  return {
    DIGITALOCEAN_TOKEN: process.env.DIGITALOCEAN_TOKEN,
  };
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function testTools(): Promise<void> {
  process.stdout.write("\n[tools] in-memory MCP client (digitalocean provider + error paths)\n");

  const saved = snapshotEnv();
  const mock = installDigitalOceanMock();
  const { client, close } = await connectClient();

  try {
    /* ---- listTools includes the deploy tools -------------------- */
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    const deployTools = [
      "create_deploy_target",
      "set_env_vars",
      "deploy",
      "get_deploy_logs",
    ];
    const missingTools = deployTools.filter((t) => !toolNames.includes(t));
    check(
      missingTools.length === 0,
      `deploy tools registered (missing: ${JSON.stringify(missingTools)})`,
    );

    /* ---- happy path: token set ---------------------------------- */
    process.env.DIGITALOCEAN_TOKEN = "do-token";

    /* ---- create_deploy_target ----------------------------------- */
    const cRes = await client.callTool({
      name: "create_deploy_target",
      arguments: { provider: "digitalocean", projectName: "web-app" },
    });
    check(!cRes.isError, `create_deploy_target ok (${firstText(cRes.content)})`);
    const cOut = CreateDeployTargetOutputSchema.parse(
      cRes.structuredContent,
    ) as CreateDeployTargetOutput;
    check(
      cOut.provider === "digitalocean",
      `create_deploy_target -> provider "digitalocean" (got "${cOut.provider}")`,
    );
    check(
      cOut.targetId === APP_ID,
      `create_deploy_target -> targetId "${APP_ID}" (got "${cOut.targetId}")`,
    );

    /* ---- set_env_vars (secret value never echoed) --------------- */
    const eRes = await client.callTool({
      name: "set_env_vars",
      arguments: {
        provider: "digitalocean",
        targetId: APP_ID,
        vars: [{ key: "API_KEY", value: "s3cr3t", secret: true }],
      },
    });
    check(!eRes.isError, `set_env_vars ok (${firstText(eRes.content)})`);
    const eOut = SetEnvVarsOutputSchema.parse(
      eRes.structuredContent,
    ) as SetEnvVarsOutput;
    check(
      eOut.setCount === 1,
      `set_env_vars -> setCount 1 (got ${eOut.setCount})`,
    );
    check(
      !(firstText(eRes.content) ?? "").includes("s3cr3t"),
      "set_env_vars result text never echoes the secret value",
    );

    /* ---- deploy (DOCR image) ------------------------------------ */
    const dRes = await client.callTool({
      name: "deploy",
      arguments: {
        provider: "digitalocean",
        targetId: APP_ID,
        projectName: "web-app",
        image: "registry.digitalocean.com/myreg/web:1.2.3",
      },
    });
    check(!dRes.isError, `deploy ok (${firstText(dRes.content)})`);
    const dOut = DeployOutputSchema.parse(dRes.structuredContent) as DeployOutput;
    check(
      dOut.deploymentId === `${APP_ID}:${DEPLOYMENT_ID}`,
      `deploy -> deploymentId "${APP_ID}:${DEPLOYMENT_ID}" (got "${dOut.deploymentId}")`,
    );

    /* ---- get_deploy_logs ---------------------------------------- */
    const gRes = await client.callTool({
      name: "get_deploy_logs",
      arguments: {
        provider: "digitalocean",
        deploymentId: `${APP_ID}:${DEPLOYMENT_ID}`,
        type: "build",
      },
    });
    check(!gRes.isError, `get_deploy_logs ok (${firstText(gRes.content)})`);
    const gOut = GetDeployLogsOutputSchema.parse(
      gRes.structuredContent,
    ) as GetDeployLogsOutput;
    check(
      gOut.logText.includes("Build completed"),
      `get_deploy_logs -> logText includes "Build completed" (got "${gOut.logText}")`,
    );

    /* ---- happy-path stayed entirely on the mock ----------------- */
    check(
      mock.blocked.length === 0,
      `happy path made no real-network escape (got ${JSON.stringify(mock.blocked)})`,
    );

    /* ---- deploy with no image -> isError mentioning image ------- */
    const noImage = await callErrors(client, "deploy", {
      provider: "digitalocean",
      targetId: APP_ID,
      projectName: "web-app",
    });
    check(noImage.errored, "deploy with no image -> isError");
    check(
      (noImage.text ?? "").toLowerCase().includes("image"),
      `no-image error mentions the image (got ${JSON.stringify(noImage.text)})`,
    );

    /* ---- missing DIGITALOCEAN_TOKEN -> isError naming it -------- */
    delete process.env.DIGITALOCEAN_TOKEN;
    const noTok = await callErrors(client, "create_deploy_target", {
      provider: "digitalocean",
      projectName: "web-app",
    });
    check(noTok.errored, "create_deploy_target with no DIGITALOCEAN_TOKEN -> isError");
    check(
      (noTok.text ?? "").toUpperCase().includes("DIGITALOCEAN_TOKEN"),
      `missing-token error names DIGITALOCEAN_TOKEN (got ${JSON.stringify(noTok.text)})`,
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
  testPureHelpers();
  await testAdapter();
  await testTools();
  process.stdout.write(`\nm4.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm4.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
