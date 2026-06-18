/**
 * confirm-token — the STATELESS, HMAC-signed destination-confirmation token
 * (M9 P3a, spec §1.2 / §1.5).
 *
 * The destination-confirmation gate is STRUCTURAL: every creating/mutating tool
 * (`create_deploy_target`, `deploy`, `provision_database`, `set_env_vars`) that
 * arrives WITHOUT a valid `confirmToken` returns `needsConfirmation` and
 * performs NO side effect. The "Yes" button re-invokes the SAME tool with the
 * SAME args plus the `confirmToken`; the tool runs the side effect only when the
 * token verifies. A deploy without a valid token can therefore NEVER create.
 *
 * The token is a compact `<payload>.<sig>` string:
 *   - payload = base64url(JSON { tool, argsHash, subject, exp, destHash })
 *   - sig     = base64url(HMAC-SHA256(secret, payload))
 *
 * It binds (subject, tool, hash(args), destinations) so a token minted for one
 * (subject, args, destination) cannot authorize a different create. Validation
 * is by recomputation of the HMAC (timing-safe) + an `exp` check — fully offline
 * and needing no DB. TRUE single-use (consume-on-success via `oauth_states`) is
 * a P3b hardening; this slice provides the structural offline guarantee.
 *
 * The signing secret comes from `BEAM_CONFIRM_TOKEN_SECRET`, with a clearly
 * marked dev default so offline tests + local self-host work out of the box. The
 * dev default is FORBIDDEN on the hosted tier (BEAM_TIER=hosted) — `secret()`
 * throws if the env var is unset there, mirroring the KEK / Postgres-TLS hosted
 * guardrails — because the public dev key would let anyone mint a valid token and
 * bypass the human "Yes, deploy" confirmation.
 */
import crypto from "node:crypto";

/** Clearly-marked dev default — override in any real deployment. */
export const DEV_CONFIRM_TOKEN_SECRET =
  "beam-me-up-dev-confirm-secret-CHANGE-ME";

/** Default TTL: 10 minutes (spec §1.5: TTL ≤ 10 min). */
export const CONFIRM_TOKEN_TTL_SECONDS = 600;

function secret(): string {
  const configured = process.env.BEAM_CONFIRM_TOKEN_SECRET?.trim();
  if (configured) return configured;
  // Hosted guardrail: the public dev default would let anyone forge a valid
  // confirmToken and bypass the human confirmation gate, so it is refused on the
  // hosted tier (mirrors buildKekProvider + the vault PG-TLS guard).
  if (process.env.BEAM_TIER === "hosted") {
    throw new Error(
      "BEAM_CONFIRM_TOKEN_SECRET is required on the hosted tier (BEAM_TIER=hosted): " +
        "without it the destination-confirmation gate could be bypassed using the " +
        "public dev default. Set a strong random secret.",
    );
  }
  return DEV_CONFIRM_TOKEN_SECRET;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Canonical, stable hash of the tool args. We strip `confirmToken` (so the hash
 * of the confirm re-invocation matches the hash minted on the gate) and sort
 * keys recursively so key-order differences don't change the hash.
 */
export function canonicalArgsHash(args: Record<string, unknown>): string {
  const canonical = canonicalize(stripConfirmToken(args));
  return crypto.createHash("sha256").update(canonical).digest("base64url");
}

function stripConfirmToken(args: Record<string, unknown>): Record<string, unknown> {
  const { confirmToken: _omit, ...rest } = args;
  return rest;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** Stable hash of the destination set the user is shown (order-independent). */
export function destinationsHash(
  destinations: Array<{ provider: string; accountLabel: string; teamLabel?: string }>,
): string {
  const norm = destinations
    .map((d) => `${d.provider}|${d.accountLabel}|${d.teamLabel ?? ""}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(norm).digest("base64url");
}

export type ConfirmTokenClaims = {
  tool: string;
  argsHash: string;
  subject: string;
  destHash: string;
  /** epoch seconds */
  exp: number;
};

export type MintConfirmTokenInput = {
  tool: string;
  subject: string;
  args: Record<string, unknown>;
  destinations: Array<{ provider: string; accountLabel: string; teamLabel?: string }>;
  ttlSeconds?: number;
  /** epoch seconds; defaults to Date.now(). Injectable for tests. */
  nowSeconds?: number;
};

export type MintedConfirmToken = { token: string; expiresAtIso: string };

export function mintConfirmToken(input: MintConfirmTokenInput): MintedConfirmToken {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? CONFIRM_TOKEN_TTL_SECONDS;
  const claims: ConfirmTokenClaims = {
    tool: input.tool,
    argsHash: canonicalArgsHash(input.args),
    subject: input.subject,
    destHash: destinationsHash(input.destinations),
    exp: now + ttl,
  };
  const payload = b64url(JSON.stringify(claims));
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return {
    token: `${payload}.${sig}`,
    expiresAtIso: new Date(claims.exp * 1000).toISOString(),
  };
}

export type VerifyConfirmTokenInput = {
  token: string;
  tool: string;
  subject: string;
  args: Record<string, unknown>;
  destinations: Array<{ provider: string; accountLabel: string; teamLabel?: string }>;
  nowSeconds?: number;
};

/**
 * Verify a confirm token by recomputing the HMAC (timing-safe) and checking the
 * binding (tool + subject + args hash + destinations hash) and expiry. Returns
 * true only when everything matches — a tampered / expired / wrong-destination
 * token returns false and the gate re-fires.
 */
export function verifyConfirmToken(input: VerifyConfirmTokenInput): boolean {
  const parts = input.token.split(".");
  if (parts.length !== 2) return false;
  const payload = parts[0];
  const sig = parts[1];
  if (!payload || !sig) return false;

  // 1. Signature must verify (timing-safe) BEFORE we trust the payload.
  const expectedSig = crypto
    .createHmac("sha256", secret())
    .update(payload)
    .digest();
  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (actualSig.length !== expectedSig.length) return false;
  if (!crypto.timingSafeEqual(actualSig, expectedSig)) return false;

  // 2. Decode + check the binding and expiry.
  let claims: ConfirmTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) return false;
  if (claims.tool !== input.tool) return false;
  if (claims.subject !== input.subject) return false;
  if (claims.argsHash !== canonicalArgsHash(input.args)) return false;
  if (claims.destHash !== destinationsHash(input.destinations)) return false;
  return true;
}
