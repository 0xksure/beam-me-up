/**
 * reviewCode - a PURE, heuristic code-vulnerability review over { path, content }
 * files (no network/FS), mirroring a manual security audit. It returns
 * prioritised findings; the host AI applies the recommendations (the server
 * never edits files).
 *
 * Style: mirror src/detect/access-control.ts + secrets.ts — regex over source,
 * skip noise/lockfiles, prefer PRECISION over recall (only flag a concrete
 * pattern you can describe + fix). Report file + 1-based line. De-duplicate
 * identical (file,line,id).
 *
 * Detectors to implement (id -> what to flag; severity; recommendation gist):
 *   - "xss-innerhtml" (high, xss): assignment to `.innerHTML` / `.outerHTML` or
 *     `insertAdjacentHTML(` / `document.write(` whose right side INTERPOLATES a
 *     variable (a template literal containing `${` or string concatenation with
 *     `+`). Recommend textContent / a sanitiser / framework escaping, and for
 *     links allowlist the URL scheme (http/https) before using it in an href.
 *   - "sql-injection" (high, injection): a SQL call — `.query(` / `.execute(` /
 *     `.raw(` — whose argument is a TEMPLATE LITERAL containing `${` OR a string
 *     built with `+`. Parameterised calls ($1/$2 with an array, or `?`
 *     placeholders) are SAFE -> do NOT flag. Recommend parameterised queries.
 *   - "command-injection" (high, injection): `exec(` / `execSync(` / `spawn(` /
 *     `spawnSync(` whose argument interpolates a variable (`${` or `+`).
 *     Recommend execFile with an args array / validated input.
 *   - "info-disclosure" (medium, info-disclosure): sending raw error detail to a
 *     client — `res.send(err`, `res.json(err)`, `res.json({ ...: String(err) })`,
 *     `res.json({ ...: err.message })`, `.send(err.stack)`, `res.status(...).
 *     json({ error: String(err) })`. Recommend logging server-side + a generic
 *     client message.
 *   - "tls-disabled" (medium, tls): `rejectUnauthorized: false`,
 *     `NODE_TLS_REJECT_UNAUTHORIZED` set to "0", or `sslmode=no-verify`.
 *     Recommend pinning the provider CA (`ssl: { ca, rejectUnauthorized: true }`).
 *   - "eval-use" (high, injection): `eval(` or `new Function(`.
 *   - "weak-crypto" (medium, crypto): `createHash("md5"|"sha1")` used for a
 *     password/token, or `Math.random()` used to build a token/secret/id.
 *   - "open-redirect" (medium, open-redirect): `res.redirect(` whose argument
 *     reads `req.query` / `req.body` / `req.params` without an allowlist.
 *   - "no-auth-mutating-route" (medium, auth): a file that registers mutating
 *     routes (`app.post(` / `.put(` / `.delete(` / `.patch(`, or `@app.post`)
 *     but has NO recognisable auth/session middleware (passport / next-auth /
 *     express-session / jsonwebtoken verify / `requireAuth` / `Depends(get_current_user`).
 *     ONE finding per file (the first mutating route line). Recommend gating
 *     mutating routes behind auth.
 *   - "missing-security-headers" (low, headers): a file that imports/creates an
 *     express app (`require("express")` / `from "express"` + `express()`) but
 *     never references `helmet`. ONE finding per such file. Recommend helmet()+CSP.
 *   - "missing-rate-limit" (low, rate-limit): an express app file with a mutating
 *     route but no `rate-limit` / `express-rate-limit` / `rateLimit(` reference.
 *     ONE finding per file. Recommend express-rate-limit on the API.
 *
 * Output: findings sorted by severity (critical>high>medium>low) then file/line;
 * `counts` of each severity; a short `summary` ("N findings: X high, Y medium,
 * …; top: <title>" or "No vulnerabilities found by the heuristic review.").
 * Skip lockfiles/minified/.map/.env files. NEVER throw; empty input -> empty.
 *
 * STUB (review_code): the body is filled in by the implementer; the signature is
 * final.
 */
import type {
  ReviewCodeInput,
  ReviewCodeOutput,
  ReviewFinding,
} from "@beam-me-up/core";

type Severity = ReviewFinding["severity"];

/* ------------------------------------------------------------------ */
/* reviewCode (the single public export)                               */
/* ------------------------------------------------------------------ */

/**
 * Heuristic vulnerability review. Pure: only looks at the provided
 * { path, content } pairs (no filesystem, no network). Per-line detectors emit
 * concrete, fixable findings; a handful of per-file detectors (no-auth route,
 * missing security headers / rate limit) fire at most once per file. Findings
 * are de-duplicated by (file,line,id), sorted by severity then file/line, and
 * summarised. NEVER throws — any unexpected error degrades to empty findings.
 */
export function reviewCode(input: ReviewCodeInput): ReviewCodeOutput {
  let findings: ReviewFinding[] = [];

  try {
    const files = input?.files ?? [];
    const seen = new Set<string>(); // de-dupe identical (file,line,id)

    for (const file of files) {
      const path = file?.path ?? "";
      const content = file?.content ?? "";
      if (!content) continue;

      const base = baseName(path).toLowerCase();
      // Skip lockfiles / minified artefacts / source maps / env files / docs.
      if (isNoiseFile(base) || isEnvFile(base) || isDocFile(base)) continue;

      // ---- per-line detectors ---------------------------------------
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const lineNo = i + 1;
        for (const hit of scanLine(line)) {
          pushFinding(findings, seen, { ...hit, file: path, line: lineNo });
        }
      }

      // ---- per-file detectors (at most one each) --------------------
      for (const hit of scanFile(content)) {
        pushFinding(findings, seen, { ...hit, file: path });
      }
    }

    findings = sortFindings(findings);
  } catch {
    // PURE + safe: never throw. A failed scan degrades to "no findings".
    findings = [];
  }

  const counts = countBySeverity(findings);
  const summary = buildSummary(findings, counts);
  return { findings, counts, summary };
}

/* ------------------------------------------------------------------ */
/* per-line detectors                                                  */
/* ------------------------------------------------------------------ */

/** A finding minus the file/line the caller fills in from position. */
type PartialFinding = Omit<ReviewFinding, "file" | "line">;
/** A per-file finding minus `file` (line is pinned by the detector). */
type FileFinding = Omit<ReviewFinding, "file">;

/**
 * Run every per-line detector against a single source line, returning zero or
 * more findings (each line can legitimately trip more than one detector, e.g. a
 * template-literal query that also interpolates). Detectors are intentionally
 * narrow: each only fires on a concrete, fixable pattern.
 */
function scanLine(line: string): PartialFinding[] {
  const out: PartialFinding[] = [];

  // ---- xss-innerhtml (high) ---------------------------------------
  if (XSS_SINK_RE.test(line) && interpolates(line)) {
    out.push({
      id: "xss-innerhtml",
      severity: "high",
      category: "xss",
      title: "HTML sink assigned interpolated/untrusted markup",
      detail:
        "An innerHTML/outerHTML assignment (or insertAdjacentHTML/document.write) " +
        "is built from an interpolated value, so attacker-controlled data is parsed " +
        "as HTML — a cross-site scripting (XSS) vector.",
      recommendation:
        "Use textContent for plain text, or sanitise the HTML (e.g. DOMPurify) / let " +
        "the framework escape it; for link URLs, allowlist the http/https scheme before " +
        "using them in an href.",
    });
  }

  // ---- sql-injection (high) ---------------------------------------
  if (isSqlCall(line) && !isParameterised(line) && interpolates(line)) {
    out.push({
      id: "sql-injection",
      severity: "high",
      category: "injection",
      title: "SQL query built by string interpolation/concatenation",
      detail:
        "A SQL call (query/execute/raw) is assembled with a template literal or " +
        "`+` concatenation, so untrusted input can alter the query — a SQL-injection " +
        "vector.",
      recommendation:
        "Use parameterised queries: pass placeholders ($1/$2 or ?) with a values " +
        "array instead of interpolating values into the SQL string.",
    });
  }

  // ---- command-injection (high) -----------------------------------
  if (CMD_SINK_RE.test(line) && interpolates(line)) {
    out.push({
      id: "command-injection",
      severity: "high",
      category: "injection",
      title: "Shell command built by string interpolation/concatenation",
      detail:
        "exec/execSync/spawn/spawnSync is invoked with a command string built from " +
        "an interpolated value, so untrusted input can inject extra shell commands.",
      recommendation:
        "Use execFile/spawn with an args array (no shell), and validate/allowlist any " +
        "input that becomes an argument.",
    });
  }

  // ---- info-disclosure (medium) -----------------------------------
  if (INFO_DISCLOSURE_RE.test(line)) {
    out.push({
      id: "info-disclosure",
      severity: "medium",
      category: "info-disclosure",
      title: "Raw error detail returned to the client",
      detail:
        "A response sends raw error text (String(err) / err.message / err.stack / the " +
        "error object) to the client, leaking stack traces, SQL, and internal paths.",
      recommendation:
        "Log the error server-side and return a generic message (e.g. " +
        '{ error: "Internal Server Error" }) with the appropriate status code.',
    });
  }

  // ---- tls-disabled (medium) --------------------------------------
  if (TLS_DISABLED_RE.test(line)) {
    out.push({
      id: "tls-disabled",
      severity: "medium",
      category: "tls",
      title: "TLS certificate verification disabled",
      detail:
        "TLS verification is turned off (rejectUnauthorized: false / " +
        "NODE_TLS_REJECT_UNAUTHORIZED=0 / sslmode=no-verify), which allows " +
        "man-in-the-middle attacks on the connection.",
      recommendation:
        "Keep verification on and pin the provider CA, e.g. " +
        "ssl: { ca, rejectUnauthorized: true }.",
    });
  }

  // ---- eval-use (high) --------------------------------------------
  if (EVAL_RE.test(line)) {
    out.push({
      id: "eval-use",
      severity: "high",
      category: "injection",
      title: "Dynamic code execution via eval / new Function",
      detail:
        "eval(...) or new Function(...) executes a string as code; if any part is " +
        "attacker-influenced it becomes arbitrary code execution.",
      recommendation:
        "Remove eval/new Function; use JSON.parse for data and a lookup table or " +
        "explicit branch for behaviour selection.",
    });
  }

  // ---- weak-crypto (medium) ---------------------------------------
  if (isWeakCrypto(line)) {
    out.push({
      id: "weak-crypto",
      severity: "medium",
      category: "crypto",
      title: "Weak cryptography for a security-sensitive value",
      detail:
        "A broken hash (MD5/SHA-1) or Math.random() is used to derive a " +
        "password/token/secret/id; both are predictable or collision-prone and " +
        "unsuitable for security.",
      recommendation:
        "Hash passwords with bcrypt/scrypt/argon2; generate tokens/ids with " +
        "crypto.randomBytes / crypto.randomUUID, not MD5/SHA-1 or Math.random().",
    });
  }

  // ---- open-redirect (medium) -------------------------------------
  if (REDIRECT_RE.test(line) && REQ_INPUT_RE.test(line)) {
    out.push({
      id: "open-redirect",
      severity: "medium",
      category: "open-redirect",
      title: "Redirect target taken from unvalidated request input",
      detail:
        "res.redirect(...) uses a value from req.query/req.body/req.params without an " +
        "allowlist, so an attacker can redirect users to a malicious site (phishing).",
      recommendation:
        "Allowlist redirect destinations (or only permit same-origin relative paths) " +
        "before calling res.redirect.",
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* per-file detectors (at most one finding each)                       */
/* ------------------------------------------------------------------ */

/**
 * File-scoped detectors that need a whole-file view: a mutating route without
 * auth, and (for express apps) missing security headers / rate limiting. Each
 * emits at most one finding and pins the line to the first relevant
 * registration so the host AI has a place to act.
 */
function scanFile(content: string): FileFinding[] {
  const out: FileFinding[] = [];

  const mutating = firstMatchLine(content, MUTATING_ROUTE_RE);
  const hasMutating = mutating !== undefined;
  const hasAuth = AUTH_MIDDLEWARE_RE.test(content);
  const isExpressApp = isExpressAppFile(content);

  // ---- no-auth-mutating-route (medium) ----------------------------
  if (hasMutating && !hasAuth) {
    out.push({
      id: "no-auth-mutating-route",
      severity: "medium",
      category: "auth",
      line: mutating,
      title: "Mutating route with no authentication",
      detail:
        "This file registers a mutating route (POST/PUT/PATCH/DELETE) but no auth/" +
        "session middleware (passport, next-auth, express-session, JWT verify, " +
        "requireAuth, Depends(get_current_user), ...) was detected, so anyone can " +
        "invoke it.",
      recommendation:
        "Gate mutating routes behind authentication (e.g. a requireAuth middleware / " +
        "session check) before they run.",
    });
  }

  // ---- missing-security-headers (low) — express app files ----------
  if (isExpressApp && !HELMET_RE.test(content)) {
    out.push({
      id: "missing-security-headers",
      severity: "low",
      category: "headers",
      line: firstMatchLine(content, EXPRESS_APP_RE) ?? 1,
      title: "Express app without security headers (no helmet)",
      detail:
        "This Express app never references helmet, so responses lack hardening " +
        "headers (CSP, HSTS, X-Content-Type-Options, frame protections).",
      recommendation:
        "Add app.use(helmet()) (with a tuned Content-Security-Policy) early in the " +
        "middleware chain.",
    });
  }

  // ---- missing-rate-limit (low) — express app files ----------------
  if (isExpressApp && hasMutating && !RATE_LIMIT_RE.test(content)) {
    out.push({
      id: "missing-rate-limit",
      severity: "low",
      category: "rate-limit",
      line: firstMatchLine(content, EXPRESS_APP_RE) ?? mutating ?? 1,
      title: "Express API without rate limiting",
      detail:
        "This Express app exposes a mutating route but never references a rate " +
        "limiter, leaving the API open to brute-force and abuse.",
      recommendation:
        "Add express-rate-limit (e.g. app.use(rateLimit({ windowMs, max }))) on the " +
        "API, especially on auth and mutating endpoints.",
    });
  }

  // ---- xss-innerhtml (high) — MULTI-LINE statements ---------------
  // The per-line detector catches `el.innerHTML = `...${x}...`` on one line.
  // This also catches the sink and its `${` interpolation spanning lines (e.g. a
  // multi-line `.map()` template), bounded to the statement (no `;` between).
  // De-dup by (file,line,id) merges single-line overlaps with the per-line hit.
  let xm: RegExpExecArray | null;
  XSS_MULTILINE_RE.lastIndex = 0;
  while ((xm = XSS_MULTILINE_RE.exec(content)) !== null) {
    out.push({
      id: "xss-innerhtml",
      severity: "high",
      category: "xss",
      line: lineAt(content, xm.index),
      title: "HTML sink assigned interpolated/untrusted markup",
      detail:
        "An innerHTML/outerHTML assignment (or insertAdjacentHTML/document.write) " +
        "interpolates a value into markup, so attacker-controlled data is parsed as " +
        "HTML — a cross-site scripting (XSS) vector.",
      recommendation:
        "Use textContent for plain text, or sanitise the HTML (e.g. DOMPurify) / let " +
        "the framework escape it; for link URLs, allowlist the http/https scheme " +
        "before using them in an href.",
    });
    if (xm.index === XSS_MULTILINE_RE.lastIndex) XSS_MULTILINE_RE.lastIndex++;
  }

  return out;
}

/** An innerHTML/outerHTML/insertAdjacentHTML/document.write sink followed by a
 *  `${` interpolation within the same statement (up to the next `;`). */
const XSS_MULTILINE_RE =
  /(?:\.\s*(?:inner|outer)HTML\s*=|\.\s*insertAdjacentHTML\s*\(|document\s*\.\s*write(?:ln)?\s*\()(?:(?!;)[\s\S]){0,500}?\$\{/g;

/** 1-based line number of a character offset in `content`. */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

/* ------------------------------------------------------------------ */
/* detector regexes + predicates                                       */
/* ------------------------------------------------------------------ */

// ---- xss-innerhtml --------------------------------------------------
// .innerHTML = / .outerHTML = ; insertAdjacentHTML( ; document.write(
const XSS_SINK_RE =
  /(?:\.\s*(?:inner|outer)HTML\s*=|\.\s*insertAdjacentHTML\s*\(|document\s*\.\s*write(?:ln)?\s*\()/;

// ---- sql-injection --------------------------------------------------
// A SQL call: .query( / .execute( / .raw(
const SQL_CALL_RE = /\.\s*(?:query|execute|raw)\s*\(/;
function isSqlCall(line: string): boolean {
  return SQL_CALL_RE.test(line);
}
// Parameterised => SAFE. Either a placeholder ($1/$2 or a bare `?`) appears, or
// a values array is passed after the SQL string. Both mark a parameterised call.
const SQL_PLACEHOLDER_RE = /\$\d+|\?/;
function isParameterised(line: string): boolean {
  return SQL_PLACEHOLDER_RE.test(line);
}

// ---- command-injection ----------------------------------------------
// exec( / execSync( / spawn( / spawnSync( as a call (not execFile, not a method
// name fragment like `.executeFoo`).
const CMD_SINK_RE = /\b(?:exec|execSync|spawn|spawnSync)\s*\(/;

// ---- info-disclosure ------------------------------------------------
// Sending raw error detail to the client: res.send(err / res.json(err) /
// objects carrying String(err) | err.message | err.stack / .send(err.stack).
const INFO_DISCLOSURE_RE =
  /\.\s*(?:send|json)\s*\([^)]*(?:String\s*\(\s*err|err\s*\.\s*(?:message|stack)|\berr\b)\s*[),]/;

// ---- tls-disabled ---------------------------------------------------
const TLS_DISABLED_RE =
  /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["'`]?0|sslmode\s*=\s*no-verify/i;

// ---- eval-use -------------------------------------------------------
// eval( as a call (not a longer identifier like `evaluate(`), or new Function(.
const EVAL_RE = /(?<![A-Za-z0-9_$])eval\s*\(|new\s+Function\s*\(/;

// ---- weak-crypto ----------------------------------------------------
const MD5_SHA1_RE = /createHash\s*\(\s*["'`](?:md5|sha1)["'`]\s*\)/i;
const MATH_RANDOM_RE = /Math\s*\.\s*random\s*\(\s*\)/;
const SECRETISH_RE = /password|token|secret|\b(?:id|uuid|nonce|salt|otp|session)\b/i;
/**
 * Weak crypto only when it is plausibly protecting something: a broken hash, or
 * Math.random() on a line that also names a password/token/secret/id. This keeps
 * the detector precise (an ordinary Math.random() for a colour is not flagged).
 */
function isWeakCrypto(line: string): boolean {
  if (MD5_SHA1_RE.test(line)) return true;
  if (MATH_RANDOM_RE.test(line) && SECRETISH_RE.test(line)) return true;
  return false;
}

// ---- open-redirect --------------------------------------------------
const REDIRECT_RE = /\.\s*redirect\s*\(/;
const REQ_INPUT_RE = /req\s*\.\s*(?:query|body|params)\b/;

// ---- interpolation (template ${...} or `+` concatenation) -----------
/** True when the line interpolates a value: a `${` template or a `+` operator. */
function interpolates(line: string): boolean {
  if (line.includes("${")) return true;
  // A `+` used as concatenation (avoid `++`, `+=`, and numeric-only "a + 1").
  return /[^+]\+(?!\+|=)/.test(line);
}

// ---- per-file: routes / auth / express ------------------------------
// A mutating route registration (express app.post / router.put / FastAPI/Flask
// @app.post). Capture the first such line for the finding.
const MUTATING_ROUTE_RE =
  /(?:\.\s*(?:post|put|patch|delete)|@\w+\.(?:post|put|patch|delete))\s*\(/i;
// Recognizable auth/session middleware or verification (mirrors access-control).
const AUTH_MIDDLEWARE_RE =
  /passport|next-auth|@auth\/|express-session|cookie-session|jsonwebtoken|\bjwt\.verify\b|express-jwt|@clerk|@supabase\/auth|@auth0|require_?auth|get_current_user|login_required|requires_auth|getServerSession|withAuth|verifyToken|verifyJwt|isAuthenticated|authMiddleware/i;
// An express app: imports express AND constructs it with express().
const EXPRESS_IMPORT_RE = /require\(\s*["']express["']\s*\)|from\s+["']express["']/;
const EXPRESS_APP_RE = /\bexpress\s*\(\s*\)/;
function isExpressAppFile(content: string): boolean {
  return EXPRESS_IMPORT_RE.test(content) && EXPRESS_APP_RE.test(content);
}
// helmet referenced anywhere in the file -> headers are (presumably) handled.
const HELMET_RE = /\bhelmet\b/;
// A rate limiter referenced anywhere -> rate limiting is (presumably) handled.
const RATE_LIMIT_RE = /rate[-_]?limit|express-rate-limit|rateLimit\s*\(/i;

/* ------------------------------------------------------------------ */
/* findings: de-dup, sort, count, summarise                            */
/* ------------------------------------------------------------------ */

/** Push a finding, skipping an identical (file,line,id) already recorded. */
function pushFinding(
  findings: ReviewFinding[],
  seen: Set<string>,
  finding: ReviewFinding,
): void {
  const key = `${finding.file}::${finding.line}::${finding.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

/** Severity rank for sorting (higher = more severe / sorts first). */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** Sort by severity (critical>high>medium>low) then file then line. */
function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Tally how many findings fall in each severity bucket. */
function countBySeverity(findings: ReviewFinding[]): ReviewCodeOutput["counts"] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/**
 * Short human summary, e.g. "3 findings: 1 high, 2 medium; top: <title>". With
 * no findings, returns the canonical "no vulnerabilities" line.
 */
function buildSummary(
  findings: ReviewFinding[],
  counts: ReviewCodeOutput["counts"],
): string {
  if (findings.length === 0) {
    return "No vulnerabilities found by the heuristic review.";
  }
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.medium) parts.push(`${counts.medium} medium`);
  if (counts.low) parts.push(`${counts.low} low`);
  const noun = findings.length === 1 ? "finding" : "findings";
  // findings is already sorted most-severe-first, so [0] is the top finding.
  const top = findings[0];
  const topPart = top ? `; top: ${top.title}` : "";
  return `${findings.length} ${noun}: ${parts.join(", ")}${topPart}`;
}

/* ------------------------------------------------------------------ */
/* small text + path utilities (house style, mirrors signals.ts)       */
/* ------------------------------------------------------------------ */

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function isNoiseFile(lowerBase: string): boolean {
  return (
    lowerBase === "package-lock.json" ||
    lowerBase === "yarn.lock" ||
    lowerBase === "pnpm-lock.yaml" ||
    lowerBase === "poetry.lock" ||
    lowerBase === "gemfile.lock" ||
    lowerBase.endsWith(".min.js") ||
    lowerBase.endsWith(".map")
  );
}

/** .env, .env.local, .env.example, .env.production, etc. */
function isEnvFile(lowerBase: string): boolean {
  return lowerBase === ".env" || lowerBase.startsWith(".env.");
}

/**
 * Prose / documentation files — not executable code. Skip them so a README that
 * *describes* a pattern (e.g. "don't set rejectUnauthorized: false") isn't itself
 * flagged as a vulnerability.
 */
function isDocFile(lowerBase: string): boolean {
  return (
    lowerBase.endsWith(".md") ||
    lowerBase.endsWith(".markdown") ||
    lowerBase.endsWith(".mdx") ||
    lowerBase.endsWith(".rst") ||
    lowerBase.endsWith(".txt")
  );
}

/** First 1-based line index where `re` matches, or undefined. */
function firstMatchLine(content: string, re: RegExp): number | undefined {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) return i + 1;
  }
  return undefined;
}
