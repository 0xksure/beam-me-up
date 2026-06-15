/**
 * m3.test.ts - offline tests for the M3 preflight_scan layer.
 *
 * preflight_scan is a PURE tool (no filesystem, no network) so - unlike
 * test/m1.test.ts / test/m2.test.ts - there is NO fetch mock and no
 * network-escape guard. We exercise the pure detectors directly and the
 * registered tool through an in-memory MCP Client. Levels covered:
 *
 *   Unit (detectors over a canonical files[] fixture):
 *     - detectSecrets / buildEnvPlan (src/detect/secrets.js): the postgres
 *       connection string + the Stripe key are found with the expected
 *       suggestedEnvKey/severity; NO `masked` value leaks the raw password
 *       ("s3cr3tPw") or the full stripe key; buildEnvPlan adds ".env" to
 *       gitignore, writes the REAL value into envFileContent (the gitignored
 *       migration target) and a BLANK value into envExampleContent.
 *     - detectStack / detectServices / detectBuild (src/detect/stack.js):
 *       frontend next, backend express, databases include postgres+redis,
 *       languages include typescript, services for app+postgres+redis,
 *       packageManager npm and the build/start/test/typecheck commands set.
 *     - detectAccessControl (src/detect/access-control.js): "product" yields a
 *       cors-wildcard + an admin/no-auth finding but NOT missing-allowlist;
 *       "internal" ALSO yields missing-allowlist.
 *
 *   Edge:
 *     - preflightScan({ files: [] }) (src/tools/preflight-scan.js) does NOT
 *       throw; secrets is [], summary is a non-empty string.
 *
 *   Tool (in-memory MCP Client, like src/smoke-test.ts):
 *     - listTools includes "preflight_scan".
 *     - calling it with { files: <fixture>, mode: "product" } is not-isError;
 *       structuredContent parses with PreflightScanOutputSchema; stack.frontend
 *       === "next", secrets.length >= 2, accessControl has a cors-wildcard.
 *     - MASKING: the raw password "s3cr3tPw" does NOT appear in
 *       JSON.stringify(out.secrets), out.summary, or out.securityFollowups,
 *       even though it MAY appear in out.envPlan.envFileContent (the migration
 *       target the host AI writes to a gitignored .env).
 *
 * Wired to `npm run test:m3` (tsx test/m3.test.ts). Prints PASS/FAIL per check
 * and exits non-zero on the first failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "@beam-me-up/server";
import { detectSecrets, buildEnvPlan } from "@beam-me-up/detect";
import {
  detectStack,
  detectServices,
  detectBuild,
} from "@beam-me-up/detect";
import { detectAccessControl } from "@beam-me-up/detect";
import { preflightScan } from "@beam-me-up/detect";
import {
  PreflightScanOutputSchema,
  type PreflightFile,
  type PreflightScanOutput,
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

/** Pull the first text block out of a tool result's `content` array, if any. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first && first.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* The canonical acceptance fixture                                    */
/* ------------------------------------------------------------------ */

/** A secret the test must never see leak into a masked finding/summary. */
const RAW_PASSWORD = "s3cr3tPw";
/** The full stripe key value (its masked preview must never reconstruct it). */
const RAW_STRIPE_KEY = "sk_live_51ABCdefGHIjklMNOpqrST";

const PACKAGE_JSON = JSON.stringify({
  name: "chatify",
  scripts: {
    dev: "next dev",
    build: "next build",
    start: "next start",
    test: "vitest run",
    typecheck: "tsc --noEmit",
  },
  dependencies: {
    next: "14.2.0",
    react: "18.3.0",
    express: "4.19.0",
    pg: "8.11.0",
    ioredis: "5.4.0",
  },
});

const SERVER_TS = [
  'import express from "express";',
  'import cors from "cors";',
  "const app = express();",
  'app.use(cors({ origin: "*" }));',
  `const DATABASE_URL = "postgres://admin:${RAW_PASSWORD}@db.example.com:5432/chatify";`,
  `const stripe = "${RAW_STRIPE_KEY}";`,
  'app.post("/admin/wipe", (req, res) => { res.end(); });',
  "app.listen(process.env.PORT || 3000);",
].join("\n");

const FIXTURE: PreflightFile[] = [
  { path: "package.json", content: PACKAGE_JSON },
  { path: "tsconfig.json", content: "{}" },
  { path: "package-lock.json", content: "{}" },
  { path: "src/server.ts", content: SERVER_TS },
];

/* ------------------------------------------------------------------ */
/* [unit] detectSecrets + buildEnvPlan                                 */
/* ------------------------------------------------------------------ */

function testSecretsAndEnvPlan(): void {
  process.stdout.write("\n[unit] detectSecrets + buildEnvPlan\n");

  const secrets = detectSecrets(FIXTURE);

  /* ---- the two expected high-severity secrets are found ----------- */
  const conn = secrets.find((s) => s.kind === "connection-string");
  check(conn !== undefined, "detectSecrets finds the postgres connection-string");
  if (conn) {
    check(
      conn.severity === "high",
      `connection-string severity "high" (got "${conn.severity}")`,
    );
    check(
      conn.suggestedEnvKey === "DATABASE_URL",
      `connection-string suggestedEnvKey "DATABASE_URL" (got "${conn.suggestedEnvKey}")`,
    );
    check(
      conn.file === "src/server.ts",
      `connection-string located in src/server.ts (got "${conn.file}")`,
    );
  }

  const stripe = secrets.find((s) => s.kind === "stripe-key");
  check(stripe !== undefined, "detectSecrets finds the Stripe live key");
  if (stripe) {
    check(
      stripe.severity === "high",
      `stripe-key severity "high" (got "${stripe.severity}")`,
    );
    check(
      /STRIPE/.test(stripe.suggestedEnvKey),
      `stripe-key suggestedEnvKey matches /STRIPE/ (got "${stripe.suggestedEnvKey}")`,
    );
  }

  check(
    secrets.length >= 2,
    `detectSecrets returns >= 2 findings (got ${secrets.length})`,
  );

  /* ---- masking: no finding ever leaks the raw values -------------- */
  const secretsJson = JSON.stringify(secrets);
  check(
    !secretsJson.includes(RAW_PASSWORD),
    `no SecretFinding leaks the raw password "${RAW_PASSWORD}"`,
  );
  check(
    !secretsJson.includes(RAW_STRIPE_KEY),
    `no SecretFinding leaks the full stripe key`,
  );
  for (const s of secrets) {
    check(
      !s.masked.includes(RAW_PASSWORD),
      `masked value for ${s.kind} does not contain the raw password`,
    );
    check(
      !s.masked.includes(RAW_STRIPE_KEY),
      `masked value for ${s.kind} does not contain the full stripe key`,
    );
  }

  /* ---- buildEnvPlan: gitignore + real .env + blank .env.example --- */
  const plan = buildEnvPlan(FIXTURE, secrets);
  check(
    plan.gitignoreAdditions.includes(".env"),
    `buildEnvPlan.gitignoreAdditions includes ".env" (got ${JSON.stringify(plan.gitignoreAdditions)})`,
  );
  check(
    plan.envAlreadyGitignored === false,
    "buildEnvPlan.envAlreadyGitignored is false (no .gitignore present)",
  );

  // The .env (migration target) keeps the REAL value so the app keeps working.
  const dbLine = plan.envFileContent
    .split("\n")
    .find((l) => l.startsWith("DATABASE_URL="));
  check(
    dbLine !== undefined,
    `envFileContent has a DATABASE_URL= line (got ${JSON.stringify(plan.envFileContent)})`,
  );
  check(
    plan.envFileContent.includes(RAW_PASSWORD),
    "envFileContent carries the REAL secret value (incl. the password)",
  );

  // The committed .env.example has the same key with a BLANK value.
  const exampleLines = plan.envExampleContent.split("\n");
  check(
    exampleLines.includes("DATABASE_URL="),
    `envExampleContent has "DATABASE_URL=" with no value (got ${JSON.stringify(plan.envExampleContent)})`,
  );
  check(
    !plan.envExampleContent.includes(RAW_PASSWORD),
    "envExampleContent does NOT carry the real secret value",
  );

  // One replacement per finding (swap each literal for an env reference).
  check(
    plan.replacements.length === secrets.length,
    `buildEnvPlan has one replacement per finding (${secrets.length}, got ${plan.replacements.length})`,
  );
}

/* ------------------------------------------------------------------ */
/* [unit] detectStack / detectServices / detectBuild                   */
/* ------------------------------------------------------------------ */

function testStackServicesBuild(): void {
  process.stdout.write("\n[unit] detectStack + detectServices + detectBuild\n");

  /* ---- detectStack ------------------------------------------------ */
  const stack = detectStack(FIXTURE);
  check(stack.frontend === "next", `stack.frontend "next" (got "${stack.frontend}")`);
  check(
    stack.backend === "express",
    `stack.backend "express" (got "${stack.backend}")`,
  );
  check(
    stack.databases.includes("postgres"),
    `stack.databases includes "postgres" (got ${JSON.stringify(stack.databases)})`,
  );
  check(
    stack.databases.includes("redis"),
    `stack.databases includes "redis" (got ${JSON.stringify(stack.databases)})`,
  );
  check(
    stack.languages.includes("typescript"),
    `stack.languages includes "typescript" (got ${JSON.stringify(stack.languages)})`,
  );
  check(
    stack.hasDockerfile === false,
    "stack.hasDockerfile is false (no Dockerfile in the fixture)",
  );
  check(
    stack.composeFiles.length === 0,
    `stack.composeFiles is empty (got ${JSON.stringify(stack.composeFiles)})`,
  );

  /* ---- detectServices --------------------------------------------- */
  const services = detectServices(FIXTURE);
  check(
    services.some((s) => s.kind === "app"),
    "detectServices includes an app service",
  );
  check(
    services.some((s) => s.kind === "postgres"),
    "detectServices includes a postgres datastore service",
  );
  check(
    services.some((s) => s.kind === "redis"),
    "detectServices includes a redis datastore service",
  );

  /* ---- detectBuild ------------------------------------------------ */
  const build = detectBuild(FIXTURE);
  check(
    build.packageManager === "npm",
    `build.packageManager "npm" (got "${build.packageManager}")`,
  );
  check(
    build.build === "npm run build",
    `build.build "npm run build" (got "${build.build}")`,
  );
  check(build.start === "npm start", `build.start "npm start" (got "${build.start}")`);
  check(build.test === "npm test", `build.test "npm test" (got "${build.test}")`);
  check(
    build.typecheck === "npm run typecheck",
    `build.typecheck "npm run typecheck" (got "${build.typecheck}")`,
  );
  check(
    build.instructions.length > 0,
    `build.instructions is non-empty (got ${build.instructions.length})`,
  );
}

/* ------------------------------------------------------------------ */
/* [unit] detectAccessControl (product vs internal)                    */
/* ------------------------------------------------------------------ */

function testAccessControl(): void {
  process.stdout.write("\n[unit] detectAccessControl product vs internal\n");

  /* ---- product mode ----------------------------------------------- */
  const product = detectAccessControl(FIXTURE, "product");
  check(
    product.some((f) => f.kind === "cors-wildcard" && f.severity === "high"),
    "product: includes a high-severity cors-wildcard finding",
  );
  check(
    product.some(
      (f) => f.kind === "open-admin-route" || f.kind === "no-auth-middleware",
    ),
    'product: includes an admin/no-auth finding ("open-admin-route" or "no-auth-middleware")',
  );
  check(
    !product.some((f) => f.kind === "missing-allowlist"),
    "product: does NOT include a missing-allowlist finding",
  );

  /* ---- internal mode ---------------------------------------------- */
  const internal = detectAccessControl(FIXTURE, "internal");
  check(
    internal.some((f) => f.kind === "missing-allowlist" && f.severity === "high"),
    "internal: ALSO includes a high-severity missing-allowlist finding",
  );
  check(
    internal.some((f) => f.kind === "cors-wildcard"),
    "internal: still includes the cors-wildcard finding",
  );
}

/* ------------------------------------------------------------------ */
/* [edge] preflightScan over an empty file list never throws           */
/* ------------------------------------------------------------------ */

function testEmptyInput(): void {
  process.stdout.write("\n[edge] preflightScan({ files: [] }) is safe\n");

  let out: PreflightScanOutput | undefined;
  let threw = false;
  try {
    out = preflightScan({ files: [] });
  } catch {
    threw = true;
  }
  check(!threw, "preflightScan({ files: [] }) does not throw");
  check(out !== undefined, "preflightScan({ files: [] }) returns an output");
  if (out) {
    check(
      Array.isArray(out.secrets) && out.secrets.length === 0,
      `empty input -> secrets is [] (got ${JSON.stringify(out.secrets)})`,
    );
    check(
      typeof out.summary === "string" && out.summary.length > 0,
      "empty input -> summary is a non-empty string",
    );
  }
}

/* ------------------------------------------------------------------ */
/* [tool] in-memory MCP client                                         */
/* ------------------------------------------------------------------ */

/** Connect an in-memory MCP Client to a fresh server. */
async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer();
  const client = new Client({ name: "beam-me-up-m3-test", version: "0.0.0" });
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

async function testTool(): Promise<void> {
  process.stdout.write("\n[tool] in-memory MCP client (preflight_scan)\n");

  const { client, close } = await connectClient();
  try {
    /* ---- listTools includes preflight_scan ----------------------- */
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    check(
      toolNames.includes("preflight_scan"),
      'tool list includes "preflight_scan"',
    );

    /* ---- call preflight_scan with the fixture -------------------- */
    const res = await client.callTool({
      name: "preflight_scan",
      arguments: { files: FIXTURE, mode: "product" },
    });
    check(!res.isError, `preflight_scan ok (${firstText(res.content)})`);

    const out = PreflightScanOutputSchema.parse(
      res.structuredContent,
    ) as PreflightScanOutput;

    check(
      out.stack.frontend === "next",
      `preflight_scan -> stack.frontend "next" (got "${out.stack.frontend}")`,
    );
    check(
      out.secrets.length >= 2,
      `preflight_scan -> secrets.length >= 2 (got ${out.secrets.length})`,
    );
    check(
      out.accessControl.some((f) => f.kind === "cors-wildcard"),
      "preflight_scan -> accessControl includes a cors-wildcard finding",
    );

    /* ---- MASKING: the raw password never leaks (except into .env) - */
    check(
      !JSON.stringify(out.secrets).includes(RAW_PASSWORD),
      `out.secrets never echoes the raw password "${RAW_PASSWORD}"`,
    );
    check(
      !out.summary.includes(RAW_PASSWORD),
      "out.summary never echoes the raw password",
    );
    check(
      !out.securityFollowups.some((f) => f.includes(RAW_PASSWORD)),
      "out.securityFollowups never echoes the raw password",
    );
    // The migration target (the gitignored .env) is ALLOWED to carry it.
    check(
      out.envPlan.envFileContent.includes(RAW_PASSWORD),
      "out.envPlan.envFileContent DOES carry the real value (migration target)",
    );
  } finally {
    await close();
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  testSecretsAndEnvPlan();
  testStackServicesBuild();
  testAccessControl();
  testEmptyInput();
  await testTool();
  process.stdout.write(`\nm3.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm3.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
