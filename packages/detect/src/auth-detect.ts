/**
 * Login / auth assessment for preflight_scan (M8).
 *
 * Pure, dependency-light (mirrors signals.ts / access-control.ts): only file
 * paths + (string) contents, no filesystem or network. One export:
 *
 *   detectAuth(files) -> AuthAssessment
 *
 * Where access-control.ts emits a NEGATIVE "no-auth-middleware" finding (fires on
 * the absence of an auth keyword), this gives the host AI a POSITIVE read it can
 * act on: does the app implement login, by what mechanism / providers, with what
 * confidence — and, when login is missing but the app serves requests, it sets
 * `offerGoogleAuth` and a `recommendation` to scaffold Google sign-in (the
 * scaffold_auth tool).
 *
 * This is a best-effort heuristic, NOT an auth audit: it recognizes common auth
 * libraries/frameworks and login routes by pattern. `confidence` + `signals`
 * (each "file:line — what was seen") make the basis explicit. It can be fooled by
 * an unrecognized library or an imported-but-unused auth helper; it never claims
 * to verify that the auth is correctly applied.
 */
import type { AuthAssessment, PreflightFile } from "@beam-me-up/core";

/* ------------------------------------------------------------------ */
/* mechanism + provider detectors                                      */
/* ------------------------------------------------------------------ */

type MechDetector = { id: string; re: RegExp; label: string; strong: boolean };

/**
 * Recognized auth mechanisms. `strong` means the mere presence is good evidence
 * of login (a dedicated auth library/framework); the non-strong ones (raw JWT)
 * only count toward "implemented" when paired with a login route + session/hash.
 */
const MECHANISMS: MechDetector[] = [
  {
    id: "next-auth",
    re: /next-auth|@auth\/(?:core|sveltekit|express)|\bNextAuth\s*\(|getServerSession|\[\.\.\.nextauth\]|\bauthOptions\b/i,
    label: "NextAuth / Auth.js",
    strong: true,
  },
  {
    // High-signal forms only — the bare word "passport" is a common non-auth
    // noun (travel/KYC/identity fields), so we require a passport.* call, a
    // passport-* strategy package, or an explicit import of "passport".
    id: "passport",
    re: /passport\.authenticate|passport\.use\s*\(|passport-[a-z0-9-]+|require\(\s*["'`]passport["'`]\s*\)|from\s+["'`]passport["'`]/i,
    label: "Passport",
    strong: true,
  },
  { id: "lucia", re: /\blucia(?:-auth)?\b/i, label: "Lucia", strong: true },
  {
    id: "iron-session",
    re: /\biron-session\b|getIronSession/i,
    label: "iron-session",
    strong: true,
  },
  {
    id: "clerk",
    re: /@clerk\/|clerkMiddleware|ClerkProvider/i,
    label: "Clerk",
    strong: true,
  },
  {
    id: "auth0",
    re: /@auth0\/|express-openid-connect|\bauth0\b/i,
    label: "Auth0",
    strong: true,
  },
  {
    id: "supabase-auth",
    re: /supabase\.auth\.|@supabase\/auth|@supabase\/auth-helpers|@supabase\/ssr/i,
    label: "Supabase Auth",
    strong: true,
  },
  {
    id: "firebase-auth",
    re: /firebase\/auth|getAuth\s*\(|signInWith[A-Za-z]+\s*\(/i,
    label: "Firebase Auth",
    strong: true,
  },
  { id: "better-auth", re: /\bbetter-auth\b/i, label: "better-auth", strong: true },
  {
    id: "django-auth",
    re: /django\.contrib\.auth|LoginRequiredMixin/i,
    label: "Django auth",
    strong: true,
  },
  {
    id: "flask-login",
    re: /flask_login|\bLoginManager\b/i,
    label: "Flask-Login",
    strong: true,
  },
  {
    id: "fastapi-security",
    re: /fastapi\.security|OAuth2PasswordBearer|Depends\s*\(\s*get_current_user/i,
    label: "FastAPI security",
    strong: true,
  },
  {
    id: "python-login-required",
    re: /@login_required|@requires_auth/i,
    label: "@login_required",
    strong: true,
  },
  {
    id: "express-session",
    re: /express-session|cookie-session/i,
    label: "express-session",
    strong: true,
  },
  {
    id: "jwt",
    re: /\bjsonwebtoken\b|\bjwt\.verify\s*\(|\bexpress-jwt\b/i,
    label: "JWT verification",
    strong: false,
  },
];

/** Social / OAuth providers, by reasonably specific markers. */
const PROVIDERS: { id: string; re: RegExp }[] = [
  {
    id: "google",
    re: /GoogleProvider|next-auth\/providers\/google|@auth\/[a-z-]+\/providers\/google|passport-google-oauth(?:20)?|accounts\.google\.com|@react-oauth\/google|google-auth-library|provider\s*[:=]\s*["'`]google["'`]/i,
  },
  {
    id: "github",
    re: /GitHubProvider|GithubProvider|passport-github|provider\s*[:=]\s*["'`]github["'`]/i,
  },
  {
    id: "microsoft",
    re: /AzureADProvider|passport-azure-ad|MicrosoftEntra|EntraIDProvider/i,
  },
  { id: "apple", re: /AppleProvider|passport-apple/i },
  { id: "facebook", re: /FacebookProvider|passport-facebook/i },
];

/* ------------------------------------------------------------------ */
/* supporting-signal patterns                                          */
/* ------------------------------------------------------------------ */

// A login/sign-in/logout/auth/session route registration.
const LOGIN_ROUTE_RE =
  /(?:\.\s*(?:get|post)\s*\(|@\w+\.(?:get|post|route)\s*\()\s*["'`][^"'`]*(?:log[-_]?in|sign[-_]?in|sign[-_]?up|log[-_]?out|\/auth|oauth|session)/i;
// Session usage (cookie/session-backed auth).
const SESSION_USE_RE =
  /\breq\.session\b|\brequest\.session\b|getServerSession|useSession\s*\(|express-session/i;
// Password hashing (a hand-rolled login almost always hashes here).
const PASSWORD_HASH_RE =
  /\bbcrypt\b|\bscrypt\b|\bargon2\b|\bpbkdf2\b|password_hash|check_password|createHash/i;
// A mutating route (POST/PUT/PATCH/DELETE) — implies the app changes state.
const MUTATING_ROUTE_RE =
  /(?:\.\s*(?:post|put|patch|delete)|@\w+\.(?:post|put|patch|delete))\s*\(/i;
// Any route registration or a server framework / listener — "this app serves requests".
const ROUTE_ANY_RE =
  /(?:\.\s*(?:get|post|put|patch|delete|use)\s*\(|@\w+\.(?:get|post|put|patch|delete|route)\s*\(|export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b)/;
const SERVER_IMPORT_RE =
  /from\s+["'](?:express|fastify|koa|next|@hapi\/hapi)["']|require\(\s*["'](?:express|fastify|koa)["']\s*\)|from\s+flask\b|import\s+flask\b|from\s+fastapi\b|import\s+fastapi\b|http\.createServer\s*\(|\.listen\s*\(/i;

/* ------------------------------------------------------------------ */
/* detectAuth                                                          */
/* ------------------------------------------------------------------ */

export function detectAuth(files: PreflightFile[]): AuthAssessment {
  const mechanisms: string[] = [];
  const mechanismIds = new Set<string>();
  const strongMechanism = { found: false };
  const providers: string[] = [];
  const providerIds = new Set<string>();
  const signals: string[] = [];
  const seenSignal = new Set<string>();

  let loginRoute = false;
  let sessionUse = false;
  let passwordHash = false;
  let mutatingRoutesPresent = false;
  let serversRequests = false;

  const addSignal = (path: string, line: number, label: string): void => {
    const s = `${path}:${line} — ${label}`;
    if (seenSignal.has(s)) return;
    seenSignal.add(s);
    signals.push(s);
  };

  for (const file of files) {
    const path = file?.path ?? "";
    const content = file?.content ?? "";
    if (!content) continue;

    const base = baseName(path).toLowerCase();
    if (isNoiseFile(base) || isEnvFile(base) || isDocFile(base)) continue;

    if (!serversRequests && (ROUTE_ANY_RE.test(content) || SERVER_IMPORT_RE.test(content))) {
      serversRequests = true;
    }
    if (!mutatingRoutesPresent && MUTATING_ROUTE_RE.test(content)) {
      mutatingRoutesPresent = true;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineNo = i + 1;

      for (const det of MECHANISMS) {
        if (!det.re.test(line)) continue;
        if (!mechanismIds.has(det.id)) {
          mechanismIds.add(det.id);
          mechanisms.push(det.id);
          addSignal(path, lineNo, `${det.label} detected`);
        }
        if (det.strong) strongMechanism.found = true;
      }

      for (const prov of PROVIDERS) {
        if (!prov.re.test(line)) continue;
        if (!providerIds.has(prov.id)) {
          providerIds.add(prov.id);
          providers.push(prov.id);
          addSignal(path, lineNo, `${prov.id} OAuth provider configured`);
        }
      }

      if (!loginRoute && LOGIN_ROUTE_RE.test(line)) {
        loginRoute = true;
        addSignal(path, lineNo, "login/auth route");
      }
      if (!sessionUse && SESSION_USE_RE.test(line)) sessionUse = true;
      if (!passwordHash && PASSWORD_HASH_RE.test(line)) passwordHash = true;
    }
  }

  // ---- verdict --------------------------------------------------------
  // Strong evidence: a dedicated auth library/framework was seen.
  // Weaker-but-sufficient: a login route plus a session or password-hash signal
  // (a hand-rolled login). A lone JWT/session keyword is NOT enough on its own.
  const handRolled = loginRoute && (sessionUse || passwordHash);
  const loginImplemented = strongMechanism.found || handRolled;

  const confidence = computeConfidence({
    loginImplemented,
    strong: strongMechanism.found,
    handRolled,
    serversRequests,
    signalCount: signals.length,
  });

  const offerGoogleAuth = !loginImplemented && serversRequests;

  const recommendation = buildRecommendation({
    loginImplemented,
    mechanisms,
    providers,
    offerGoogleAuth,
    serversRequests,
    mutatingRoutesPresent,
  });

  return {
    loginImplemented,
    mechanisms,
    providers,
    confidence,
    signals: signals.slice(0, 10),
    mutatingRoutesPresent,
    recommendation,
    offerGoogleAuth,
  };
}

/* ------------------------------------------------------------------ */
/* confidence + recommendation                                         */
/* ------------------------------------------------------------------ */

function computeConfidence(args: {
  loginImplemented: boolean;
  strong: boolean;
  handRolled: boolean;
  serversRequests: boolean;
  signalCount: number;
}): number {
  if (args.loginImplemented) {
    // A recognized library is strong evidence; a hand-rolled login less so.
    const base = args.strong ? 0.85 : 0.6;
    const bonus = Math.min(0.1, Math.max(0, args.signalCount - 1) * 0.03);
    return round2(Math.min(0.95, base + bonus));
  }
  // Absent: we're more sure it's truly missing when the app clearly serves
  // requests (so there was somewhere auth would live) than for a static blob.
  return args.serversRequests ? 0.7 : 0.5;
}

function buildRecommendation(args: {
  loginImplemented: boolean;
  mechanisms: string[];
  providers: string[];
  offerGoogleAuth: boolean;
  serversRequests: boolean;
  mutatingRoutesPresent: boolean;
}): string {
  if (args.loginImplemented) {
    const mech = args.mechanisms.length
      ? args.mechanisms.join(", ")
      : "a login route";
    const prov = args.providers.length
      ? ` (providers: ${args.providers.join(", ")})`
      : "";
    return (
      `Login appears implemented via ${mech}${prov}. This is a heuristic — ` +
      `verify the auth is actually applied to protected routes, session cookies ` +
      `are httpOnly/secure/sameSite, and (for internal apps) sign-in is gated to ` +
      `an allowlist.`
    );
  }
  if (args.offerGoogleAuth) {
    const why = args.mutatingRoutesPresent
      ? "it exposes mutating routes (POST/PUT/DELETE) that should be protected"
      : "it serves requests";
    return (
      `No login/auth was detected, but ${why}. OFFER the user to add sign-in, and ` +
      `on a yes call scaffold_auth { provider: "google", framework } to generate a ` +
      `ready-to-apply Google sign-in scaffold.`
    );
  }
  return (
    `No login/auth was detected and the app does not appear to serve user requests ` +
    `(no routes/server found). Add auth only if you expose user-specific or ` +
    `mutating endpoints — then call scaffold_auth.`
  );
}

/* ------------------------------------------------------------------ */
/* small path/number helpers (house style, mirrors signals.ts)         */
/* ------------------------------------------------------------------ */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

function isEnvFile(lowerBase: string): boolean {
  return lowerBase === ".env" || lowerBase.startsWith(".env.");
}

// Docs describe auth without implementing it; skip to cut false positives.
function isDocFile(lowerBase: string): boolean {
  return (
    lowerBase.endsWith(".md") ||
    lowerBase.endsWith(".markdown") ||
    lowerBase.endsWith(".mdx") ||
    lowerBase.endsWith(".rst") ||
    lowerBase.endsWith(".txt")
  );
}
