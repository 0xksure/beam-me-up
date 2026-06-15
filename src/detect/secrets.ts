/**
 * Secret detection + .env migration planning for preflight_scan (M3).
 *
 * Pure, dependency-light: we only look at file paths and their (string)
 * contents (mirrors src/detect/signals.ts). No filesystem or network access.
 *
 * GOAL: find credentials hardcoded in source so the host AI can move them into
 * a gitignored .env. Two exports:
 *
 *   detectSecrets(files)  -> SecretFinding[]
 *   buildEnvPlan(files, secrets) -> EnvPlan
 *
 * detectSecrets heuristics (regex over source-ish files; skip noise/lockfiles,
 * skip .env / .env.example themselves, skip obvious test fixtures where helpful):
 *   - high:   private keys ("-----BEGIN ... PRIVATE KEY-----"); cloud keys
 *             (AWS "AKIA"+16, "aws_secret_access_key=..."); provider live keys
 *             (Stripe "sk_live_"/"rk_live_", GitHub "ghp_"/"gho_", Slack "xox[bap]-",
 *             Google "AIza", OpenAI "sk-"+long, Twilio "SK"+32); connection
 *             strings with inline credentials
 *             (postgres://user:pass@host, mongodb+srv://user:pass@, redis://:pass@,
 *             mysql://user:pass@, amqps://user:pass@); JWTs ("eyJ"... .. ..).
 *   - medium: generic API-key / token / secret / password ASSIGNMENTS to a
 *             non-empty, non-placeholder string literal, e.g.
 *             API_KEY = "....", const password = "....", "secret": "...."
 *             (>= ~8 chars, not "changeme"/"xxx"/"<...>"/"your-..."/env refs).
 *   - low:    weaker / lower-entropy hits.
 *
 * IMPORTANT — never leak the secret: `masked` is a redacted preview only
 * (e.g. first 3-4 chars + "…" + last 2-4 chars, or just the kind for private
 * keys). NEVER put the full matched value anywhere in the output.
 *
 * Ignore values that are clearly NOT secrets: process.env.X references,
 * placeholders ("changeme", "xxx", "<your-key>", "your-...-here", "example",
 * "test", empty strings), and import paths.
 *
 * suggestedEnvKey: derive a SCREAMING_SNAKE_CASE env name from context — reuse
 * the assigned variable/key name when there is one (API_KEY -> "API_KEY",
 * stripeSecret -> "STRIPE_SECRET"); for a tagged provider/connection string use
 * a conventional name (Stripe -> "STRIPE_SECRET_KEY", a postgres URL ->
 * "DATABASE_URL", a redis URL -> "REDIS_URL", AWS secret -> "AWS_SECRET_ACCESS_KEY").
 * De-duplicate identical (file,line,kind) hits.
 *
 * buildEnvPlan:
 *   - envFileContent: one "KEY=value" line per UNIQUE suggestedEnvKey, value =
 *     the real (UNMASKED) found secret, so the app keeps working once it reads
 *     from process.env. (This is the .env the host AI writes locally and
 *     gitignores — it is the migration target, not chat output.) Stable order.
 *   - envExampleContent: the same keys with blank values ("KEY=") for a
 *     committed .env.example.
 *   - gitignoreAdditions: [".env"] UNLESS a .gitignore in `files` already
 *     ignores ".env" (then []). Also set envAlreadyGitignored accordingly.
 *   - replacements: one EnvReplacement per secret finding { file, line, envKey,
 *     note } telling the host AI to swap the literal for the env reference.
 *
 * STUB (M3 skeleton): the bodies are filled in by the implementer; the
 * signatures are final.
 */
import type {
  EnvPlan,
  EnvReplacement,
  PreflightFile,
  SecretFinding,
} from "../schemas.js";

type Severity = SecretFinding["severity"];

/** Raw, unmasked secret captured alongside its finding (NEVER leaves this module). */
type RawSecret = SecretFinding & { raw: string };

/* ------------------------------------------------------------------ */
/* detectSecrets                                                       */
/* ------------------------------------------------------------------ */

/**
 * Scan each file's content for hardcoded credentials. Pure: only looks at the
 * provided { path, content } pairs. Returns masked findings (the full secret is
 * never echoed). Empty input -> empty output.
 */
export function detectSecrets(files: PreflightFile[]): SecretFinding[] {
  return detectRawSecrets(files).map(stripRaw);
}

/**
 * Internal: same scan as detectSecrets but keeps the raw matched value so the
 * env plan can write the real value into the (gitignored) .env. The raw value
 * is dropped before anything is returned from a public export.
 */
function detectRawSecrets(files: PreflightFile[]): RawSecret[] {
  const out: RawSecret[] = [];
  const seen = new Set<string>(); // de-dupe identical (file,line,kind)

  for (const file of files) {
    const path = file?.path ?? "";
    const content = file?.content ?? "";
    if (!content) continue;

    const base = baseName(path).toLowerCase();
    // Skip lockfiles / minified artefacts and the env files themselves.
    if (isNoiseFile(base)) continue;
    if (isEnvFile(base)) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineNo = i + 1;
      for (const hit of scanLine(line)) {
        const dedupeKey = `${path}::${lineNo}::${hit.kind}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push({
          file: path,
          line: lineNo,
          kind: hit.kind,
          masked: mask(hit.raw, hit.kind),
          suggestedEnvKey: hit.suggestedEnvKey,
          severity: hit.severity,
          raw: hit.raw,
        });
      }
    }
  }

  return out;
}

function stripRaw(s: RawSecret): SecretFinding {
  const { raw: _raw, ...finding } = s;
  return finding;
}

/* ------------------------------------------------------------------ */
/* per-line scanning                                                   */
/* ------------------------------------------------------------------ */

type LineHit = {
  kind: string;
  raw: string;
  severity: Severity;
  suggestedEnvKey: string;
};

/**
 * Run the tagged/high-confidence detectors first, then fall back to the generic
 * assignment detector. A single line can yield multiple hits of different kinds
 * (they de-dupe by kind upstream).
 */
function scanLine(line: string): LineHit[] {
  const hits: LineHit[] = [];

  for (const det of TAGGED_DETECTORS) {
    const re = new RegExp(det.re.source, det.re.flags.includes("g") ? det.re.flags : det.re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const raw = (m[0] ?? "").trim();
      if (!raw) {
        if (m.index === re.lastIndex) re.lastIndex++;
        continue;
      }
      hits.push({
        kind: det.kind,
        raw,
        severity: det.severity,
        suggestedEnvKey: det.envKey(raw),
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // Generic "<name> = "<value>"" assignment of a secret-ish key. Only consult
  // this when the line names a secret-ish identifier, to keep false positives
  // low. Skip if a tagged provider/connection detector already claimed a value
  // on this line (avoids double-counting the same literal).
  const generic = scanGenericAssignment(line);
  if (generic) {
    const alreadyTagged = hits.some((h) => generic.raw.includes(h.raw) || h.raw.includes(generic.raw));
    if (!alreadyTagged) hits.push(generic);
  }

  return hits;
}

/* ------------------------------------------------------------------ */
/* tagged / high-confidence detectors                                  */
/* ------------------------------------------------------------------ */

type TaggedDetector = {
  kind: string;
  re: RegExp;
  severity: Severity;
  envKey: (raw: string) => string;
};

const TAGGED_DETECTORS: TaggedDetector[] = [
  // ---- private keys (PEM headers) ------------------------------------
  {
    kind: "private-key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    severity: "high",
    envKey: () => "PRIVATE_KEY",
  },

  // ---- connection strings with inline credentials --------------------
  // Capture the whole URL; placed before bare-provider keys so e.g. a
  // postgres URL is classified as a connection-string, not a generic value.
  {
    kind: "connection-string",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|amqps?|redis|rediss):\/\/[^\s"'`]*:[^\s"'`@]+@[^\s"'`]+/,
    severity: "high",
    envKey: (raw) => connectionEnvKey(raw),
  },
  // redis://:password@host has no user before the colon — handled above by
  // the same pattern (user part optional via [^\s"'`]*).

  // ---- AWS access key id --------------------------------------------
  {
    kind: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    severity: "high",
    envKey: () => "AWS_ACCESS_KEY_ID",
  },

  // ---- provider live / api keys --------------------------------------
  {
    kind: "stripe-key",
    re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/,
    severity: "high",
    envKey: () => "STRIPE_SECRET_KEY",
  },
  {
    kind: "github-token",
    re: /\bgh[posu]_[0-9A-Za-z]{20,}\b/,
    severity: "high",
    envKey: () => "GITHUB_TOKEN",
  },
  {
    kind: "slack-token",
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
    severity: "high",
    envKey: () => "SLACK_TOKEN",
  },
  {
    kind: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    severity: "high",
    envKey: () => "GOOGLE_API_KEY",
  },
  {
    kind: "twilio-key",
    re: /\bSK[0-9a-fA-F]{32}\b/,
    severity: "high",
    envKey: () => "TWILIO_API_KEY",
  },
  {
    kind: "openai-key",
    re: /\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}\b/,
    severity: "high",
    envKey: () => "OPENAI_API_KEY",
  },

  // ---- JWT ------------------------------------------------------------
  {
    kind: "jwt",
    re: /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\b/,
    severity: "high",
    envKey: () => "JWT_TOKEN",
  },
];

/* ------------------------------------------------------------------ */
/* generic secret assignment detector (medium)                         */
/* ------------------------------------------------------------------ */

/**
 * Matches an assignment of a SECRET-ish identifier to a non-empty,
 * non-placeholder string literal:
 *
 *   const apiKey = "abcd1234..."       (=)
 *   API_KEY: "abcd1234..."             (object / yaml-ish)
 *   "secret": "abcd1234..."            (JSON)
 *
 * The identifier must contain key/token/secret/password/passwd/pwd/api.?key/
 * auth/credential. The value must be >= 8 chars and not an obvious placeholder
 * or env reference.
 */
const SECRET_NAME = /(api[_-]?key|secret|password|passwd|pwd|token|auth|credential|access[_-]?key|private[_-]?key)/i;
const ASSIGNMENT_RE =
  /["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*["'`]([^"'`]{6,})["'`]/g;

function scanGenericAssignment(line: string): LineHit | null {
  let m: RegExpExecArray | null;
  ASSIGNMENT_RE.lastIndex = 0;
  while ((m = ASSIGNMENT_RE.exec(line)) !== null) {
    const name = m[1] ?? "";
    const value = m[2] ?? "";
    if (!SECRET_NAME.test(name)) continue;
    if (isPlaceholderValue(value)) continue;
    if (value.length < 8) continue;
    const isPassword = /password|passwd|pwd/i.test(name);
    return {
      kind: isPassword ? "password-literal" : "generic-api-key",
      raw: value,
      severity: "medium",
      suggestedEnvKey: envKeyFromName(name),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* placeholder / non-secret filtering                                  */
/* ------------------------------------------------------------------ */

function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v === "") return true;
  // process.env references and template interpolations are not secrets.
  if (/process\.env/i.test(v)) return true;
  if (/^\$\{?/.test(v) || /\$\{/.test(v)) return true;
  if (/^<.*>$/.test(v)) return true; // <your-key>
  const lower = v.toLowerCase();
  const placeholders = [
    "changeme",
    "change-me",
    "your-key",
    "your_key",
    "yourkey",
    "your-api-key",
    "your-secret",
    "example",
    "placeholder",
    "todo",
    "xxx",
    "xxxx",
    "...",
    "secret",
    "password",
    "test",
    "dummy",
    "none",
    "null",
    "undefined",
  ];
  if (placeholders.includes(lower)) return true;
  if (/your[-_].*(key|secret|token|here)/.test(lower)) return true;
  if (/[-_]here$/.test(lower)) return true; // ..._here
  if (/^x+$/.test(lower)) return true; // xxxxxxxx
  return false;
}

/* ------------------------------------------------------------------ */
/* env-key derivation                                                  */
/* ------------------------------------------------------------------ */

/** SCREAMING_SNAKE_CASE from an assigned identifier (camelCase or snake). */
function envKeyFromName(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return snake || "SECRET";
}

/** Conventional env key for a credentialed connection string by scheme. */
function connectionEnvKey(raw: string): string {
  const scheme = /^([a-z+]+):\/\//i.exec(raw.trim());
  const s = (scheme?.[1] ?? "").toLowerCase();
  if (s.startsWith("postgres")) return "DATABASE_URL";
  if (s.startsWith("mysql")) return "DATABASE_URL";
  if (s.startsWith("mongodb")) return "MONGODB_URI";
  if (s.startsWith("redis") || s.startsWith("rediss")) return "REDIS_URL";
  if (s.startsWith("amqp")) return "AMQP_URL";
  return "DATABASE_URL";
}

/* ------------------------------------------------------------------ */
/* masking                                                             */
/* ------------------------------------------------------------------ */

/**
 * Produce a redacted preview of a secret. NEVER returns the full value:
 *   - private keys -> just a label (no key material at all)
 *   - connection strings -> scheme + masked host, with the password elided
 *   - everything else -> first 3-4 chars + "…" + last 2-4 chars
 *
 * For short values we still drop the middle so the raw secret is never fully
 * reconstructable from `masked`.
 */
function mask(raw: string, kind: string): string {
  const value = raw.trim();

  if (kind === "private-key") {
    return "-----BEGIN PRIVATE KEY----- […redacted…]";
  }

  if (kind === "connection-string") {
    return maskConnectionString(value);
  }

  return maskToken(value);
}

function maskToken(value: string): string {
  const len = value.length;
  if (len <= 4) return "…";
  // Keep a short, recognizable prefix and suffix; never enough to reconstruct.
  const head = value.slice(0, Math.min(4, Math.max(1, Math.floor(len / 4))));
  const tail = value.slice(-Math.min(4, Math.max(1, Math.floor(len / 4))));
  // Ensure head/tail don't overlap (would leak the whole short value).
  if (head.length + tail.length >= len) {
    return `${value.slice(0, 2)}…`;
  }
  return `${head}…${tail}`;
}

/**
 * Mask a credentialed URL: keep the scheme and host shape but elide BOTH the
 * password and most of the host so no credential survives.
 *   postgres://admin:s3cr3tPw@db.example.com:5432/chatify
 *     -> postgres://***:***@db.…/…
 */
function maskConnectionString(value: string): string {
  const m = /^([a-z+]+):\/\/(?:([^:/@\s]+)(?::[^@\s]+)?@)?([^/\s]*)(.*)$/i.exec(value);
  if (!m) return maskToken(value);
  const scheme = m[1] ?? "";
  const user = m[2];
  const host = m[3] ?? "";
  const hostHead = host.split(/[.:]/)[0] ?? "";
  const hostMasked = hostHead ? `${hostHead.slice(0, Math.min(3, hostHead.length))}…` : "…";
  const cred = user ? "***:***@" : "";
  return `${scheme}://${cred}${hostMasked}/…`;
}

/* ------------------------------------------------------------------ */
/* buildEnvPlan                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the .env migration plan from the (masked) findings. Because the public
 * SecretFinding[] no longer carries the raw value, we re-scan `files` here to
 * recover the real values for the .env file (the gitignored migration target).
 *
 *   - envFileContent    : one `KEY=value` line per UNIQUE suggestedEnvKey, value
 *                         = the real found secret (UNMASKED). Stable order.
 *   - envExampleContent : the same keys with blank values (`KEY=`).
 *   - gitignoreAdditions: [".env"] unless a .gitignore already ignores ".env".
 *   - envAlreadyGitignored / replacements: per the contract.
 */
export function buildEnvPlan(
  files: PreflightFile[],
  secrets: SecretFinding[],
): EnvPlan {
  // Recover raw values keyed by suggestedEnvKey from a fresh scan.
  const rawByKey = new Map<string, string>();
  for (const r of detectRawSecrets(files)) {
    if (!rawByKey.has(r.suggestedEnvKey)) rawByKey.set(r.suggestedEnvKey, r.raw);
  }

  // Stable, de-duplicated ordering of keys as they first appear in `secrets`.
  const orderedKeys: string[] = [];
  const keySet = new Set<string>();
  for (const s of secrets) {
    if (keySet.has(s.suggestedEnvKey)) continue;
    keySet.add(s.suggestedEnvKey);
    orderedKeys.push(s.suggestedEnvKey);
  }

  const envLines: string[] = [];
  const exampleLines: string[] = [];
  for (const key of orderedKeys) {
    const value = rawByKey.get(key) ?? "";
    envLines.push(`${key}=${value}`);
    exampleLines.push(`${key}=`);
  }
  const envFileContent = envLines.length ? envLines.join("\n") + "\n" : "";
  const envExampleContent = exampleLines.length
    ? exampleLines.join("\n") + "\n"
    : "";

  // One replacement per finding (swap the inline literal for an env reference).
  const replacements: EnvReplacement[] = secrets.map((s) => ({
    file: s.file,
    line: s.line,
    envKey: s.suggestedEnvKey,
    note: `Replace the hardcoded ${s.kind} with process.env.${s.suggestedEnvKey} and load it from .env.`,
  }));

  const envAlreadyGitignored = gitignoreCoversEnv(files);
  const gitignoreAdditions = envAlreadyGitignored ? [] : [".env"];

  return {
    envFileContent,
    envExampleContent,
    gitignoreAdditions,
    envAlreadyGitignored,
    replacements,
  };
}

/** True if a .gitignore in `files` already ignores the `.env` file. */
function gitignoreCoversEnv(files: PreflightFile[]): boolean {
  for (const file of files) {
    const base = baseName(file?.path ?? "").toLowerCase();
    if (base !== ".gitignore") continue;
    const lines = (file.content ?? "").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      // Match common ways .env gets ignored: ".env", "/.env", "*.env", ".env*".
      if (line === ".env" || line === "/.env") return true;
      if (line === "*.env" || line === ".env*") return true;
      // Note: ".env.*" alone does NOT cover the literal ".env" file.
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* small path helpers (mirror src/detect/signals.ts)                   */
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

/** The .env / .env.example family — we don't scan these for secrets. */
function isEnvFile(lowerBase: string): boolean {
  return lowerBase === ".env" || lowerBase.startsWith(".env.");
}
