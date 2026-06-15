/**
 * Access-control / security-posture heuristics for preflight_scan (M3).
 *
 * Pure, dependency-light (mirrors src/detect/signals.ts): only file paths +
 * (string) contents; no filesystem or network. One export:
 *
 *   detectAccessControl(files, mode) -> AccessControlFinding[]
 *
 * These are best-effort static heuristics, NOT a real scanner (the host AI runs
 * `npm audit` etc. itself). Each finding is { kind, severity, file?, line?,
 * message, recommendation }. Skip noise/lockfiles. Prefer precision over recall:
 * only flag a pattern you can describe concretely with a fix.
 *
 * Checks to implement (kind -> what to look for):
 *   - "cors-wildcard" (high): CORS configured to allow any origin —
 *     cors({ origin: "*" }) / Access-Control-Allow-Origin: * /
 *     app.use(cors()) with no options when credentials are also enabled.
 *   - "bind-all-interfaces" (low): server bound to 0.0.0.0 / host="0.0.0.0"
 *     (informational; common in containers).
 *   - "debug-enabled" (medium): DEBUG=True (Django settings), app.run(debug=True),
 *     NODE_ENV !== production hardcoded, Flask debug, express errorhandler in prod.
 *   - "weak-secret-default" (high): a framework secret with a hardcoded/default
 *     value — SECRET_KEY = "..."/"changeme", NEXTAUTH_SECRET literal,
 *     JWT secret literal, session secret literal, "django-insecure-" prefix.
 *     (Overlaps secrets.ts; here the angle is "auth/session secret with a
 *     guessable or committed default".)
 *   - "no-auth-middleware" (medium): a server with routes but no recognizable
 *     auth/session middleware (no passport/next-auth/@auth/express-session/
 *     jsonwebtoken verification/Depends(get_current_user) etc.) AND the app
 *     exposes mutating routes (app.post/put/delete, @app.post). Best-effort.
 *   - "open-admin-route" (high): an /admin (or /internal) route handler with no
 *     adjacent auth guard.
 *   - "missing-allowlist" (high, ONLY when mode === "internal"): no
 *     ALLOWED_EMAILS / ALLOWED_DOMAIN reference anywhere — an internal app must
 *     gate sign-in to an allowlist (see the beam_me_up plan, step 13).
 *
 * `mode`: "product" (public sign-in expected) vs "internal" (allowlist
 * required). The "missing-allowlist" check fires only for internal.
 *
 * Keep messages specific ("CORS allows any origin with credentials enabled")
 * and recommendations actionable ("Restrict origin to your deployed domain(s).").
 *
 * STUB (M3 skeleton): the body is filled in by the implementer; the signature
 * is final.
 */
import type {
  AccessControlFinding,
  PreflightFile,
} from "@beam-me-up/core";

export function detectAccessControl(
  files: PreflightFile[],
  mode: "product" | "internal",
): AccessControlFinding[] {
  const findings: AccessControlFinding[] = [];

  // Track repo-wide facts that the per-file checks accumulate so we can emit
  // a few cross-file findings (no-auth-middleware, missing-allowlist) once.
  let sawMutatingRoute = false;
  let sawAuthMiddleware = false;
  let sawAllowlist = false;

  for (const file of files) {
    const path = file.path ?? "";
    const content = file.content ?? "";
    const lowerBase = baseName(path).toLowerCase();

    // Skip generated/lockfiles and the env files themselves (secrets.ts owns
    // those; an access-control reviewer should not re-flag .env contents).
    if (isNoiseFile(lowerBase) || isEnvFile(lowerBase)) continue;

    // ---- accumulate repo-wide auth signals ----------------------------
    if (hasMutatingRoute(content)) sawMutatingRoute = true;
    if (hasAuthMiddleware(content)) sawAuthMiddleware = true;
    if (hasAllowlistReference(content)) sawAllowlist = true;

    // ---- cors-wildcard (high) -----------------------------------------
    for (const hit of findCorsWildcard(content)) {
      findings.push({
        kind: "cors-wildcard",
        severity: "high",
        file: path,
        line: hit.line,
        message: hit.credentials
          ? "CORS allows any origin (\"*\") with credentials enabled, exposing authenticated endpoints to any site."
          : "CORS is configured to allow any origin (\"*\").",
        recommendation:
          "Restrict the CORS origin to your deployed domain(s) instead of \"*\".",
      });
    }

    // ---- bind-all-interfaces (low) ------------------------------------
    {
      const line = findLine(content, BIND_ALL_RE);
      if (line) {
        findings.push({
          kind: "bind-all-interfaces",
          severity: "low",
          file: path,
          line,
          message:
            "Server binds to 0.0.0.0 (all network interfaces). Informational; common and expected inside containers.",
          recommendation:
            "Fine in a container; if running on a host directly, bind to 127.0.0.1 and put it behind a reverse proxy.",
        });
      }
    }

    // ---- debug-enabled (medium) ---------------------------------------
    {
      const hit = findDebugEnabled(content);
      if (hit) {
        findings.push({
          kind: "debug-enabled",
          severity: "medium",
          file: path,
          line: hit.line,
          message: `Debug mode appears to be enabled (${hit.label}), which can leak stack traces and internals in production.`,
          recommendation:
            "Disable debug mode in production; drive it from an env var that defaults to off.",
        });
      }
    }

    // ---- weak-secret-default (high) -----------------------------------
    for (const hit of findWeakSecretDefault(content)) {
      findings.push({
        kind: "weak-secret-default",
        severity: "high",
        file: path,
        line: hit.line,
        message: `Auth/session secret "${hit.name}" uses a hardcoded or guessable default value.`,
        recommendation:
          "Generate a strong random secret and load it from an env var; never commit the value.",
      });
    }

    // ---- open-admin-route (high) --------------------------------------
    for (const hit of findOpenAdminRoutes(content)) {
      findings.push({
        kind: "open-admin-route",
        severity: "high",
        file: path,
        line: hit.line,
        message: `Admin/internal route "${hit.route}" has no adjacent auth guard.`,
        recommendation:
          "Require authentication and an admin role/allowlist on this route before exposing it.",
      });
    }
  }

  // ---- no-auth-middleware (medium, repo-wide) -------------------------
  // The app exposes mutating routes but we never saw recognizable auth/session
  // middleware anywhere. Best-effort; emitted once.
  if (sawMutatingRoute && !sawAuthMiddleware) {
    findings.push({
      kind: "no-auth-middleware",
      severity: "medium",
      message:
        "Mutating routes (POST/PUT/DELETE) are present but no auth/session middleware (passport, next-auth, express-session, JWT verification, get_current_user, ...) was detected.",
      recommendation:
        "Add an auth/session middleware and protect mutating routes before deploying.",
    });
  }

  // ---- missing-allowlist (high, internal mode only) -------------------
  // An internal app must gate sign-in to an allowlist; flag when no
  // ALLOWED_EMAILS / ALLOWED_DOMAIN reference appears anywhere.
  if (mode === "internal" && !sawAllowlist) {
    findings.push({
      kind: "missing-allowlist",
      severity: "high",
      message:
        "Internal mode: no ALLOWED_EMAILS / ALLOWED_DOMAIN allowlist reference found, so sign-in is not gated to your organization.",
      recommendation:
        "Gate sign-in to an ALLOWED_EMAILS or ALLOWED_DOMAIN allowlist so only your team can access the app.",
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* CORS wildcard                                                       */
/* ------------------------------------------------------------------ */

/**
 * Find CORS-allows-any-origin configurations, returning the 1-based line and
 * whether credentials are also enabled (which makes the wildcard far worse).
 *
 * Patterns:
 *   - cors({ origin: "*" })            (express `cors` middleware)
 *   - Access-Control-Allow-Origin: *  (manual header, any casing/quoting)
 *   - app.use(cors())                  bare cors() WITH credentials:true nearby
 */
function findCorsWildcard(
  content: string,
): { line: number; credentials: boolean }[] {
  const hits: { line: number; credentials: boolean }[] = [];
  const lines = content.split(/\r?\n/);
  const credentialsEnabled = CREDENTIALS_RE.test(content);

  // cors({ origin: "*" }) — origin set to a literal "*".
  // Access-Control-Allow-Origin: * — manual header, in a string or YAML/config.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (CORS_ORIGIN_WILDCARD_RE.test(line) || ACAO_WILDCARD_RE.test(line)) {
      hits.push({ line: i + 1, credentials: credentialsEnabled });
    }
  }

  // Bare `cors()` (no options) only counts when credentials are enabled — an
  // open default with credentials is the dangerous combination called out in
  // the doc-comment. Skip if we already flagged an explicit wildcard.
  if (hits.length === 0 && credentialsEnabled) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (BARE_CORS_RE.test(line)) {
        hits.push({ line: i + 1, credentials: true });
        break;
      }
    }
  }

  return hits;
}

// origin: "*"  /  origin: '*'  (with optional spacing); part of a cors() config.
const CORS_ORIGIN_WILDCARD_RE = /origin\s*:\s*["'`]\*["'`]/;
// Access-Control-Allow-Origin: * (header literal, any casing).
const ACAO_WILDCARD_RE = /access-control-allow-origin["'`]?\s*[:,]\s*["'`]?\*/i;
// app.use(cors()) with no arguments.
const BARE_CORS_RE = /\bcors\s*\(\s*\)/;
// credentials: true / Access-Control-Allow-Credentials: true / withCredentials.
const CREDENTIALS_RE =
  /credentials\s*:\s*true|access-control-allow-credentials["'`]?\s*[:,]\s*["'`]?\s*true|withCredentials\s*:\s*true/i;

/* ------------------------------------------------------------------ */
/* bind-all-interfaces                                                 */
/* ------------------------------------------------------------------ */

// host: "0.0.0.0" / host="0.0.0.0" / listen(port, "0.0.0.0") / --host 0.0.0.0.
const BIND_ALL_RE =
  /(?:host\s*[:=]\s*["'`]?0\.0\.0\.0|listen\s*\([^)]*["'`]0\.0\.0\.0["'`]|--host[=\s]+0\.0\.0\.0|0\.0\.0\.0\s*:\s*\d{2,5})/;

/* ------------------------------------------------------------------ */
/* debug-enabled                                                       */
/* ------------------------------------------------------------------ */

/**
 * Detect a hardcoded debug-mode-on. Returns the 1-based line + a short label
 * for the message. We require an explicit literal `true`/`True` so we do not
 * mis-fire on `debug = process.env.DEBUG === "true"` style env-driven flags.
 */
function findDebugEnabled(
  content: string,
): { line: number; label: string } | undefined {
  const checks: { re: RegExp; label: string }[] = [
    // Django settings.py: DEBUG = True
    { re: /\bDEBUG\s*=\s*True\b/, label: "DEBUG = True" },
    // Flask / generic python: app.run(debug=True)
    { re: /\.run\s*\([^)]*debug\s*=\s*True/, label: "app.run(debug=True)" },
    // Flask: app.debug = True
    { re: /\.debug\s*=\s*True\b/, label: "app.debug = True" },
    // Node: NODE_ENV hardcoded to a non-production literal.
    {
      re: /NODE_ENV\s*[:=]\s*["'`](?:development|debug)["'`]/,
      label: "NODE_ENV hardcoded to development",
    },
    // Express dev error handler (leaks stack traces) wired unconditionally.
    { re: /require\(\s*["']errorhandler["']\s*\)/, label: "express errorhandler" },
    { re: /from\s+["']errorhandler["']/, label: "express errorhandler" },
  ];
  const lines = content.split(/\r?\n/);
  for (const { re, label } of checks) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i] ?? "")) return { line: i + 1, label };
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* weak-secret-default                                                 */
/* ------------------------------------------------------------------ */

/**
 * A framework auth/session secret assigned a hardcoded string literal. We only
 * flag the secret-bearing NAMES (SECRET_KEY, NEXTAUTH_SECRET, JWT/session
 * secret, ...) so this stays distinct from the broader secrets.ts scan, and we
 * report the NAME only — never the literal value. The `django-insecure-` prefix
 * is Django's own marker for a committed default and is always flagged.
 */
function findWeakSecretDefault(
  content: string,
): { line: number; name: string }[] {
  const hits: { line: number; name: string }[] = [];
  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Django's committed default secret marker.
    if (/["'`]django-insecure-/.test(line)) {
      pushHit(hits, seen, i + 1, "SECRET_KEY");
      continue;
    }

    const m = SECRET_ASSIGN_RE.exec(line);
    if (!m) continue;
    const name = m[1] ?? "";
    const value = m[2] ?? "";
    if (!isWeakSecretValue(value)) continue;
    pushHit(hits, seen, i + 1, name);
  }
  return hits;
}

function pushHit(
  hits: { line: number; name: string }[],
  seen: Set<string>,
  line: number,
  name: string,
): void {
  const key = `${line}:${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  hits.push({ line, name });
}

// A secret-bearing identifier assigned a single/double/back-quoted literal.
// Matches SECRET_KEY = "...", const jwtSecret = '...', "session_secret": "...".
const SECRET_ASSIGN_RE =
  /["'`]?([A-Za-z_][A-Za-z0-9_]*(?:SECRET|secret)[A-Za-z0-9_]*)["'`]?\s*[:=]\s*["'`]([^"'`]*)["'`]/;

/**
 * Treat the literal as a weak/committed default when it is present but obviously
 * not a real strong secret: short, a known placeholder, or env-ref-like. A long
 * high-entropy literal is still a problem (it is a committed secret) so we flag
 * it too — the angle here is "a literal value at all, on an auth secret".
 */
function isWeakSecretValue(value: string): boolean {
  const v = value.trim();
  if (v === "") return false; // empty -> sourced from env elsewhere, not a default.
  const lower = v.toLowerCase();
  // env-reference / template placeholders are not committed defaults.
  if (
    v.startsWith("process.env") ||
    v.startsWith("$") ||
    v.startsWith("${") ||
    v.startsWith("<") ||
    lower.includes("your-") ||
    lower.includes("env(")
  ) {
    return false;
  }
  // Any concrete literal on an auth secret is a finding (guessable defaults like
  // "changeme"/"secret" AND committed real values both qualify).
  return true;
}

/* ------------------------------------------------------------------ */
/* open-admin-route                                                    */
/* ------------------------------------------------------------------ */

/**
 * Routes whose path starts with /admin or /internal and whose handler has no
 * auth guard on the same line. Best-effort, line-based — we look for a route
 * registration (express app.METHOD / router.METHOD, Flask/FastAPI decorators,
 * Next.js route paths) targeting an /admin or /internal path, and only flag it
 * when there is no obvious guard token on that line.
 */
function findOpenAdminRoutes(
  content: string,
): { line: number; route: string }[] {
  const hits: { line: number; route: string }[] = [];
  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = ROUTE_DEF_RE.exec(line);
    if (!m) continue;
    const route = m[1] ?? "";
    if (!ADMIN_PATH_RE.test(route)) continue;
    // Guard present on the same registration line -> not "open".
    if (GUARD_TOKEN_RE.test(line)) continue;
    const key = `${i + 1}:${route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ line: i + 1, route });
  }
  return hits;
}

// A route registration with a quoted path:
//   app.post("/admin/wipe", ...)  router.get('/internal/x', ...)
//   @app.post("/admin")           @router.delete("/internal")  (FastAPI/Flask)
const ROUTE_DEF_RE =
  /(?:\.\s*(?:get|post|put|patch|delete|all|use)|@\w+\.(?:get|post|put|patch|delete|route))\s*\(\s*["'`]([^"'`]+)["'`]/i;
// Path begins with /admin or /internal (with optional trailing segment).
const ADMIN_PATH_RE = /^\/(?:admin|internal)(?:[/?#]|$)/i;
// An auth guard token co-located on the route line.
const GUARD_TOKEN_RE =
  /requireAuth|requireAdmin|isAuthenticated|isAdmin|ensureAuth|ensureLoggedIn|authMiddleware|authenticate|adminOnly|verifyToken|verifyJwt|checkAuth|passport\.authenticate|Depends\s*\(|@login_required|@admin_required|@requires_auth|getServerSession|withAuth/i;

/* ------------------------------------------------------------------ */
/* repo-wide auth signals                                              */
/* ------------------------------------------------------------------ */

// A mutating route is registered somewhere (POST/PUT/PATCH/DELETE).
const MUTATING_ROUTE_RE =
  /(?:\.\s*(?:post|put|patch|delete)|@\w+\.(?:post|put|patch|delete))\s*\(/i;
function hasMutatingRoute(content: string): boolean {
  return MUTATING_ROUTE_RE.test(content);
}

// Recognizable auth/session middleware or verification.
const AUTH_MIDDLEWARE_RE =
  /passport|next-auth|@auth\/|express-session|cookie-session|jsonwebtoken|\bjwt\.verify\b|express-jwt|@clerk|@supabase\/auth|@auth0|require_?auth|get_current_user|login_required|requires_auth|getServerSession|withAuth|verifyToken|verifyJwt|isAuthenticated|authMiddleware/i;
function hasAuthMiddleware(content: string): boolean {
  return AUTH_MIDDLEWARE_RE.test(content);
}

// An allowlist reference (internal-mode gate).
const ALLOWLIST_RE = /ALLOWED_EMAILS|ALLOWED_DOMAINS?|ALLOWLIST|ALLOW_LIST/;
function hasAllowlistReference(content: string): boolean {
  return ALLOWLIST_RE.test(content);
}

/* ------------------------------------------------------------------ */
/* small text + path utilities (house style, mirrors signals.ts)      */
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

// .env, .env.local, .env.example, .env.production, etc. — owned by secrets.ts.
function isEnvFile(lowerBase: string): boolean {
  return lowerBase === ".env" || lowerBase.startsWith(".env.");
}

/** First 1-based line index where `re` matches, or undefined. */
function findLine(content: string, re: RegExp): number | undefined {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) return i + 1;
  }
  return undefined;
}
