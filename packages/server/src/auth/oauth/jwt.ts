/**
 * Pure JWT verification (M5) — node:crypto only, no deps, no network.
 *
 * verifyJwt(token, opts) validates a compact JWS (header.payload.signature):
 *   1. split into 3 base64url parts; decode header + payload JSON.
 *   2. header.alg MUST equal opts.alg (reject "none" and any mismatch — this is
 *      the alg-confusion guard; never trust the token's own alg to pick the key).
 *   3. verify the signature over `${header}.${payload}`:
 *        - HS256: crypto.createHmac("sha256", opts.secret) and timing-safe-compare
 *          (crypto.timingSafeEqual) against the decoded signature bytes.
 *        - RS256: crypto.createVerify("RSA-SHA256").verify(opts.publicKeyPem, sig).
 *   4. claims: exp present and now < exp (with clockToleranceSec, default 60);
 *      nbf (if present) <= now; iat sanity optional; iss === opts.issuer;
 *      aud contains opts.audience (aud may be a string or string[]).
 *   On ANY failure throw a JwtError with a stable `code`
 *   ("malformed" | "alg-mismatch" | "bad-signature" | "expired" | "not-before" |
 *    "issuer" | "audience"). On success return the decoded claims.
 *
 * `now` (seconds since epoch) is injectable for deterministic tests; default
 * Math.floor(Date.now()/1000).
 *
 * STUB (M5 skeleton): the bodies are filled in by the implementer; the
 * signatures + types are final.
 */

/** Registered + common claims we read (others pass through). */
export type JwtClaims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  /** space-delimited scopes (RFC 8693 / OAuth). */
  scope?: string;
  /** array-form scopes (some ASes use this). */
  scp?: string[];
  /** OAuth client id, if present. */
  client_id?: string;
  [claim: string]: unknown;
};

export type JwtVerifyOptions = {
  alg: "HS256" | "RS256";
  secret?: string;
  publicKeyPem?: string;
  issuer: string;
  audience: string;
  clockToleranceSec?: number;
  /** Injectable clock (seconds since epoch) for tests. */
  now?: number;
};

export class JwtError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JwtError";
    this.code = code;
  }
}

import crypto from "node:crypto";

/**
 * Decode a base64url string (RFC 7515 §2: "-_" alphabet, no padding) into a
 * Buffer. Node's "base64url" decoder accepts the URL-safe alphabet and tolerates
 * the absence of "=" padding, so this is a thin, dependency-free wrapper.
 */
function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Parse a base64url-encoded JSON segment (the JWS header or payload). Any decode
 * or JSON failure surfaces as a JwtError("malformed") so callers never see a raw
 * SyntaxError. The token text itself is never included in the message.
 */
function decodeJsonSegment(segment: string): Record<string, unknown> {
  let json: string;
  try {
    json = base64UrlDecode(segment).toString("utf8");
  } catch {
    throw new JwtError("malformed", "JWT segment is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new JwtError("malformed", "JWT segment is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JwtError("malformed", "JWT segment is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Verify a compact JWS access token and return its decoded claims.
 *
 * Security properties enforced here (see the file-level doc-comment):
 *   - structural validation (3 base64url parts, JSON header + payload);
 *   - the alg-confusion guard: the header `alg` MUST equal `opts.alg`, and we
 *     pick the verification key purely from `opts`, NEVER from the token header;
 *   - signature verification over the ASCII signing input `${part0}.${part1}`
 *     (HS256 via timing-safe HMAC compare, RS256 via RSA-SHA256 verify);
 *   - registered-claim checks (exp / nbf / iss / aud) with a clock tolerance.
 *
 * @throws {JwtError} with a stable `code` on any failure.
 */
export function verifyJwt(token: string, opts: JwtVerifyOptions): JwtClaims {
  if (typeof token !== "string" || token.length === 0) {
    throw new JwtError("malformed", "JWT is empty");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtError("malformed", "JWT must have three parts");
  }
  const [part0, part1, part2] = parts;
  if (
    part0 === undefined ||
    part1 === undefined ||
    part2 === undefined ||
    part0.length === 0 ||
    part1.length === 0 ||
    part2.length === 0
  ) {
    throw new JwtError("malformed", "JWT has an empty segment");
  }

  const header = decodeJsonSegment(part0);
  const payload = decodeJsonSegment(part1) as JwtClaims;

  // --- Alg-confusion guard -------------------------------------------------
  // The header alg must match the algorithm the verifier was configured with.
  // We never look at the header to choose the key/algorithm; that would let an
  // attacker downgrade (e.g. "none") or confuse RS256<->HS256.
  const headerAlg = header.alg;
  if (headerAlg === "none") {
    throw new JwtError("alg-mismatch", "JWT alg \"none\" is not allowed");
  }
  if (typeof headerAlg !== "string" || headerAlg !== opts.alg) {
    throw new JwtError("alg-mismatch", "JWT alg does not match expected algorithm");
  }

  // --- Signature verification ---------------------------------------------
  // The signing input is the ASCII bytes of the first two segments joined by a
  // dot, exactly as they appear in the token (no re-encoding).
  const signingInput = `${part0}.${part1}`;
  let signature: Buffer;
  try {
    signature = base64UrlDecode(part2);
  } catch {
    throw new JwtError("malformed", "JWT signature is not valid base64url");
  }

  if (opts.alg === "HS256") {
    if (typeof opts.secret !== "string" || opts.secret.length === 0) {
      throw new JwtError("bad-signature", "HS256 secret is not configured");
    }
    const expected = crypto
      .createHmac("sha256", opts.secret)
      .update(signingInput, "ascii")
      .digest();
    // Length-check first: crypto.timingSafeEqual throws on length mismatch.
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(signature, expected)
    ) {
      throw new JwtError("bad-signature", "JWT signature verification failed");
    }
  } else {
    // RS256
    if (typeof opts.publicKeyPem !== "string" || opts.publicKeyPem.length === 0) {
      throw new JwtError("bad-signature", "RS256 public key is not configured");
    }
    let ok = false;
    try {
      ok = crypto
        .createVerify("RSA-SHA256")
        .update(signingInput, "ascii")
        .verify(opts.publicKeyPem, signature);
    } catch {
      throw new JwtError("bad-signature", "JWT signature verification failed");
    }
    if (!ok) {
      throw new JwtError("bad-signature", "JWT signature verification failed");
    }
  }

  // --- Claim checks --------------------------------------------------------
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tol = opts.clockToleranceSec ?? 60;

  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new JwtError("expired", "JWT has no valid exp claim");
  }
  if (now > exp + tol) {
    throw new JwtError("expired", "JWT has expired");
  }

  const nbf = payload.nbf;
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isFinite(nbf)) {
      throw new JwtError("not-before", "JWT has an invalid nbf claim");
    }
    if (now + tol < nbf) {
      throw new JwtError("not-before", "JWT is not yet valid");
    }
  }

  if (payload.iss !== opts.issuer) {
    throw new JwtError("issuer", "JWT issuer does not match");
  }

  const aud = payload.aud;
  const audMatches =
    typeof aud === "string"
      ? aud === opts.audience
      : Array.isArray(aud) && aud.includes(opts.audience);
  if (!audMatches) {
    throw new JwtError("audience", "JWT audience does not match");
  }

  return payload;
}
