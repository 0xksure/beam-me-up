/**
 * m7.test.ts - tests for review_code (the vulnerability review tool). PURE: no
 * network, no mock. Modeled on test/m3.test.ts (the check() PASS/FAIL printer,
 * an in-memory MCP Client via InMemoryTransport + createServer, the
 * main().catch(...) exit, and a final "m7.test: PASS (<n> checks)" line).
 *
 * Build a deliberately-VULNERABLE fixture (an Express + pg + frontend app, much
 * like beam-test-app BEFORE hardening) and cover:
 *   [unit] reviewCode (from "../src/detect/review.js"... i.e. @beam-me-up/detect):
 *     finds, at minimum, an "xss-innerhtml" finding (a `.innerHTML =` with `${`),
 *     a "sql-injection" finding (a `.query(\`...${id}...\`)` template), a
 *     "tls-disabled" finding (`rejectUnauthorized: false`), an "info-disclosure"
 *     finding (`res.json({ error: String(err) })`), a "no-auth-mutating-route"
 *     finding (an `app.post` with no auth middleware), and "missing-security-
 *     headers" + "missing-rate-limit" for the express app. Each finding has a
 *     non-empty `recommendation`, a valid severity, and a file/line.
 *   [unit] a SAFE snippet (parameterised `query("... WHERE id=$1", [id])`) does
 *     NOT produce a sql-injection finding (precision / no false positives).
 *   [edge] reviewCode({ files: [] }) does NOT throw; findings [] and counts all 0.
 *   [tool] in-memory MCP client: listTools includes "review_code"; calling it
 *     with the vulnerable fixture returns not-isError; structuredContent parses
 *     with ReviewCodeOutputSchema; counts.high >= 1 and summary is non-empty.
 *
 * Wired to `npm run test:m7` (tsx test/m7.test.ts).
 *
 * STUB (review_code): the test body is filled in by the implementer.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "@beam-me-up/server";
import { reviewCode } from "@beam-me-up/detect";
import {
  ReviewCodeOutputSchema,
  type PreflightFile,
  type ReviewCodeOutput,
  type ReviewFinding,
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

/** A severity is one of the four allowed values. */
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/** Find the first finding with the given id (or undefined). */
function byId(
  findings: ReviewFinding[],
  id: string,
): ReviewFinding | undefined {
  return findings.find((f) => f.id === id);
}

/* ------------------------------------------------------------------ */
/* The canonical VULNERABLE acceptance fixture                         */
/* ------------------------------------------------------------------ */

/**
 * An Express + pg backend with multiple deliberate vulnerabilities:
 *   - TLS verification disabled on the pg Pool (rejectUnauthorized: false)
 *   - a SQL query built by template-literal interpolation (GET /api/items/:id)
 *   - a parameterised INSERT that is SAFE and must NOT be flagged
 *   - raw error detail returned to the client (String(err))
 *   - a mutating POST route with no auth middleware
 *   - no helmet (missing security headers) and no rate limiting
 */
const SERVER_JS = [
  'import express from "express";',
  'import pg from "pg";',
  "const app = express();",
  "app.use(express.json());",
  "const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });",
  'app.get("/api/items/:id", async (req, res) => {',
  "  try {",
  "    const { rows } = await pool.query(`SELECT * FROM items WHERE id = ${req.params.id}`);",
  "    res.json(rows);",
  "  } catch (err) { res.status(500).json({ error: String(err) }); }",
  "});",
  'app.post("/api/items", async (req, res) => {',
  '  await pool.query("INSERT INTO items (name) VALUES ($1)", [req.body.name]);',
  "  res.json({ ok: true });",
  "});",
  "app.listen(8080);",
].join("\n");

/** A frontend that writes interpolated markup into innerHTML (XSS). */
const APP_JS = [
  'const out = document.getElementById("out");',
  "out.innerHTML = `<b>${data.name}</b>`;",
].join("\n");

const FIXTURE: PreflightFile[] = [
  { path: "server.js", content: SERVER_JS },
  { path: "public/app.js", content: APP_JS },
];

/** A SAFE, fully parameterised query — the precision counter-example. */
const SAFE_DB_JS = [
  'import pg from "pg";',
  "const pool = new pg.Pool();",
  "export async function getItem(id) {",
  '  const { rows } = await pool.query("SELECT * FROM items WHERE id = $1", [id]);',
  "  return rows[0];",
  "}",
].join("\n");

/* ------------------------------------------------------------------ */
/* [unit] reviewCode over the vulnerable fixture                       */
/* ------------------------------------------------------------------ */

function testReviewFindings(): void {
  process.stdout.write("\n[unit] reviewCode finds the expected vulnerabilities\n");

  const out = reviewCode({ files: FIXTURE });
  const findings = out.findings;

  // ---- the seven expected detector ids are all present -------------
  const expected: { id: string; file: string }[] = [
    { id: "xss-innerhtml", file: "public/app.js" },
    { id: "sql-injection", file: "server.js" },
    { id: "tls-disabled", file: "server.js" },
    { id: "info-disclosure", file: "server.js" },
    { id: "no-auth-mutating-route", file: "server.js" },
    { id: "missing-security-headers", file: "server.js" },
    { id: "missing-rate-limit", file: "server.js" },
  ];
  for (const { id, file } of expected) {
    const f = byId(findings, id);
    check(f !== undefined, `reviewCode finds a "${id}" finding`);
    if (f) {
      check(
        f.file === file,
        `"${id}" is located in ${file} (got "${f.file}")`,
      );
      check(
        typeof f.line === "number" && f.line >= 1,
        `"${id}" has a 1-based line (got ${f.line})`,
      );
      check(
        SEVERITIES.has(f.severity),
        `"${id}" has a valid severity (got "${f.severity}")`,
      );
      check(
        typeof f.recommendation === "string" && f.recommendation.length > 0,
        `"${id}" has a non-empty recommendation`,
      );
      check(
        typeof f.title === "string" && f.title.length > 0,
        `"${id}" has a non-empty title`,
      );
    }
  }

  // ---- the sql-injection finding is the template-literal query ------
  const sql = byId(findings, "sql-injection");
  check(
    sql !== undefined && sql.line === 8,
    `the sql-injection finding points at the template query on line 8 (got ${sql?.line})`,
  );

  // ---- counts agree with the findings array ------------------------
  const recomputed = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) recomputed[f.severity] += 1;
  check(
    out.counts.critical === recomputed.critical &&
      out.counts.high === recomputed.high &&
      out.counts.medium === recomputed.medium &&
      out.counts.low === recomputed.low,
    `counts match the findings array (counts=${JSON.stringify(out.counts)})`,
  );
  check(
    out.counts.high >= 2,
    `at least two high-severity findings (got ${out.counts.high})`,
  );

  // ---- findings are sorted by severity (critical>high>medium>low) ---
  const rank: Record<ReviewFinding["severity"], number> = {
    critical: 3,
    high: 2,
    medium: 1,
    low: 0,
  };
  let sorted = true;
  for (let i = 1; i < findings.length; i++) {
    const prev = findings[i - 1]!;
    const cur = findings[i]!;
    if (rank[prev.severity] < rank[cur.severity]) sorted = false;
    if (rank[prev.severity] === rank[cur.severity] && prev.file > cur.file) {
      sorted = false;
    }
  }
  check(sorted, "findings are sorted by severity then file/line");

  // ---- summary is a non-empty string -------------------------------
  check(
    typeof out.summary === "string" && out.summary.length > 0,
    `summary is a non-empty string (got "${out.summary}")`,
  );
}

/* ------------------------------------------------------------------ */
/* [unit] precision: a parameterised query is NOT flagged              */
/* ------------------------------------------------------------------ */

function testNoFalsePositive(): void {
  process.stdout.write("\n[unit] precision: parameterised query is not flagged\n");

  // The vulnerable fixture's parameterised INSERT (server.js line 13) must not
  // produce a sql-injection finding — only the template-literal query should.
  const fixtureSql = reviewCode({ files: FIXTURE }).findings.filter(
    (f) => f.id === "sql-injection",
  );
  check(
    fixtureSql.length === 1,
    `exactly one sql-injection in the fixture — the parameterised INSERT is NOT flagged (got ${fixtureSql.length})`,
  );

  // A standalone, safe, parameterised module yields no sql-injection at all.
  const safe = reviewCode({ files: [{ path: "db.js", content: SAFE_DB_JS }] });
  check(
    !safe.findings.some((f) => f.id === "sql-injection"),
    "a fully parameterised query module produces NO sql-injection finding",
  );

  // A MULTI-LINE innerHTML statement (the sink + the `${` on different lines, as
  // in a .map() template) must still be flagged as xss-innerhtml.
  const multilineXss = [
    "const list = document.getElementById('list');",
    "list.innerHTML = items.map((it) =>",
    "  `<li><a href=\"${it.url}\">${it.title}</a></li>`",
    ").join('');",
  ].join("\n");
  const ml = reviewCode({ files: [{ path: "ui.js", content: multilineXss }] });
  check(
    ml.findings.some((f) => f.id === "xss-innerhtml"),
    "a multi-line innerHTML interpolation is flagged as xss-innerhtml",
  );

  // A README that DESCRIBES a vuln pattern in prose must NOT be flagged (docs
  // are skipped) — otherwise documentation triggers false positives.
  const doc = reviewCode({
    files: [
      {
        path: "README.md",
        content: "Do not use `ssl: { rejectUnauthorized: false }` in production.",
      },
    ],
  });
  check(
    doc.findings.length === 0,
    `a markdown doc mentioning a pattern produces NO findings (got ${JSON.stringify(doc.findings.map((f) => f.id))})`,
  );
}

/* ------------------------------------------------------------------ */
/* [edge] reviewCode over an empty file list never throws              */
/* ------------------------------------------------------------------ */

function testEmptyInput(): void {
  process.stdout.write("\n[edge] reviewCode({ files: [] }) is safe\n");

  let out: ReviewCodeOutput | undefined;
  let threw = false;
  try {
    out = reviewCode({ files: [] });
  } catch {
    threw = true;
  }
  check(!threw, "reviewCode({ files: [] }) does not throw");
  check(out !== undefined, "reviewCode({ files: [] }) returns an output");
  if (out) {
    check(
      Array.isArray(out.findings) && out.findings.length === 0,
      `empty input -> findings is [] (got ${JSON.stringify(out.findings)})`,
    );
    check(
      out.counts.critical === 0 &&
        out.counts.high === 0 &&
        out.counts.medium === 0 &&
        out.counts.low === 0,
      `empty input -> all counts are 0 (got ${JSON.stringify(out.counts)})`,
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
async function connectClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const client = new Client({ name: "beam-me-up-m7-test", version: "0.0.0" });
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
  process.stdout.write("\n[tool] in-memory MCP client (review_code)\n");

  const { client, close } = await connectClient();
  try {
    /* ---- listTools includes review_code -------------------------- */
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    check(toolNames.includes("review_code"), 'tool list includes "review_code"');

    /* ---- call review_code with the vulnerable fixture ------------ */
    const res = await client.callTool({
      name: "review_code",
      arguments: { files: FIXTURE },
    });
    check(!res.isError, `review_code ok (${firstText(res.content)})`);

    const out = ReviewCodeOutputSchema.parse(
      res.structuredContent,
    ) as ReviewCodeOutput;

    check(
      out.counts.high >= 1,
      `review_code -> counts.high >= 1 (got ${out.counts.high})`,
    );
    check(
      typeof out.summary === "string" && out.summary.length > 0,
      "review_code -> summary is a non-empty string",
    );
    check(
      out.findings.some((f) => f.id === "sql-injection"),
      "review_code -> findings include a sql-injection",
    );
    check(
      out.findings.some((f) => f.id === "xss-innerhtml"),
      "review_code -> findings include an xss-innerhtml",
    );
    check(
      out.findings.every(
        (f) =>
          typeof f.recommendation === "string" && f.recommendation.length > 0,
      ),
      "review_code -> every finding has a non-empty recommendation",
    );
  } finally {
    await close();
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  testReviewFindings();
  testNoFalsePositive();
  testEmptyInput();
  await testTool();
  process.stdout.write(`\nm7.test: PASS (${passCount} checks)\n`);
}

main().catch((err) => {
  process.stderr.write(`\nm7.test: FAIL - ${String(err)}\n`);
  process.exit(1);
});
