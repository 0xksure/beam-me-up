/**
 * JWKS key resolver (M9 / P0) - fetch + cache an Authorization Server's public
 * signing keys so the Resource Server can verify RS256 access tokens whose
 * signing key ROTATES (the normal case for a managed IdP like WorkOS AuthKit),
 * instead of pinning a single static PEM.
 *
 * This is a key-RESOLUTION layer that sits IN FRONT of the audited, unchanged
 * verifyJwt() crypto: it picks WHICH RS256 public key to use, by the token's
 * header `kid`. It never chooses the algorithm - verifyJwt still enforces the
 * alg-confusion guard (header.alg MUST equal the configured "RS256", "none"
 * rejected). Selecting a key by `kid` is standard and safe; the algorithm stays
 * fixed by config.
 *
 * It is network-facing TRUST code, so it is hardened against the failure modes
 * the design review flagged:
 *   - HTTPS-only: the JWKS URI must be https (loopback exempted for local dev),
 *     and redirects are refused (no cross-host redirect to an attacker origin).
 *   - Bounded, de-duplicated refresh: at most one fetch per `cooldownMs` window;
 *     an unknown `kid` triggers at most ONE refresh per cooldown (so a flood of
 *     random kids can't be a fetch-amplification DoS). Concurrent misses share a
 *     single in-flight fetch (coalesced).
 *   - Hard fetch timeout via AbortController.
 *   - Stale-on-error: a failed refresh NEVER drops a usable cache and NEVER
 *     fails open - if the requested key can't be resolved, callers get an error
 *     and the request is rejected.
 *   - Capped cache size.
 *
 * The resolver returns a PEM string so verifyJwt's `publicKeyPem` contract is
 * unchanged. JWKs are imported with node:crypto (no dependencies).
 */
import crypto from "node:crypto";

/** Resolves the RS256 public key (PEM) for a token's `kid`. */
export interface JwksResolver {
  /**
   * Return the PEM for the given `kid` (or the sole key when a token omits
   * `kid`). Refreshes from the JWKS endpoint when needed, within the configured
   * rate limits. Rejects with a JwksError when no usable key can be resolved.
   */
  getPublicKeyPem(kid: string | undefined): Promise<string>;
}

/** Minimal fetch shape so tests can inject a stub without a real network. */
export type JwksFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type JwksResolverOptions = {
  /** The Authorization Server's JWKS URL (https, or loopback for local dev). */
  jwksUri: string;
  /** The AS issuer (recorded for context; the JWT `iss` is checked by verifyJwt). */
  issuer: string;
  /** Injected fetch (tests); defaults to a hardened wrapper over global fetch. */
  fetchImpl?: JwksFetch;
  /** Injectable clock in ms (tests); defaults to Date.now. */
  now?: () => number;
  /** Cache lifetime before a lookup forces a refresh (default 10 min). */
  ttlMs?: number;
  /** Minimum spacing between fetches; bounds unknown-kid refreshes (default 30 s). */
  cooldownMs?: number;
  /** Hard timeout for a single JWKS fetch (default 5 s). */
  timeoutMs?: number;
  /** Maximum keys cached from one JWKS document (default 16). */
  maxKeys?: number;
};

/** Stable-coded error so the verifier can map JWKS failures to a 401. */
export class JwksError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JwksError";
    this.code = code;
  }
}

/** Sentinel cache key for a JWK that carries no `kid` (namespaced so it cannot
 *  collide with any real key id an Authorization Server would publish). */
const NO_KID = "__beam_no_kid__";

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

/** Import one JWK (RSA signing key) to a SPKI PEM, or null if unusable. */
function jwkToPem(jwk: Record<string, unknown>): string | null {
  if (jwk.kty !== "RSA") return null; // only RSA signing keys
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  if (jwk.alg !== undefined && jwk.alg !== "RS256") return null;
  try {
    const key = crypto.createPublicKey({
      key: jwk as crypto.JsonWebKey,
      format: "jwk",
    });
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    return null;
  }
}

/** Parse a JWKS document into [kid -> PEM] pairs, skipping unusable keys. */
function parseJwks(body: unknown): Array<[string, string]> {
  if (body === null || typeof body !== "object") {
    throw new JwksError("malformed", "JWKS response is not an object");
  }
  const keys = (body as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new JwksError("malformed", "JWKS response has no keys array");
  }
  const out: Array<[string, string]> = [];
  for (const entry of keys) {
    if (entry === null || typeof entry !== "object") continue;
    const jwk = entry as Record<string, unknown>;
    const pem = jwkToPem(jwk);
    if (pem === null) continue;
    const kid = typeof jwk.kid === "string" && jwk.kid.length > 0 ? jwk.kid : NO_KID;
    out.push([kid, pem]);
  }
  return out;
}

/**
 * Build a JwksResolver bound to one JWKS endpoint. Construction validates the
 * URL (https or loopback); fetching is lazy (on first lookup).
 */
export function createJwksResolver(options: JwksResolverOptions): JwksResolver {
  const jwksUrl = new URL(options.jwksUri); // throws on an invalid URL
  if (jwksUrl.protocol !== "https:" && !isLoopbackHost(jwksUrl.hostname)) {
    throw new JwksError(
      "config",
      "JWKS URI must be https (loopback is allowed for local development)",
    );
  }

  const nowFn = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const cooldownMs = options.cooldownMs ?? 30 * 1000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxKeys = options.maxKeys ?? 16;

  const MAX_JWKS_BYTES = 1024 * 1024; // 1 MiB - generous for a key set, bounds OOM.
  const doFetch: JwksFetch =
    options.fetchImpl ??
    (async (url, init) => {
      // Hardened default: refuse cross-host redirects, ask for JSON, and cap the
      // body so a hostile/buggy endpoint can't OOM us. The body read shares the
      // abort signal, so the caller's timeout also tears down a slow-dribbling
      // response (not just the headers).
      const res = await fetch(url, {
        redirect: "error",
        signal: init?.signal,
        headers: { accept: "application/json" },
      });
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_JWKS_BYTES) {
        throw new JwksError("too-large", "JWKS response exceeds the size cap");
      }
      const text = await res.text();
      if (text.length > MAX_JWKS_BYTES) {
        throw new JwksError("too-large", "JWKS response exceeds the size cap");
      }
      return {
        ok: res.ok,
        status: res.status,
        json: async () => JSON.parse(text) as unknown,
      };
    });

  const cache = new Map<string, string>();
  let lastFetchMs = Number.NEGATIVE_INFINITY; // last SUCCESSFUL refresh (TTL/staleness)
  let lastAttemptMs = Number.NEGATIVE_INFINITY; // last ATTEMPT, success or fail (rate limit)
  let inFlight: Promise<void> | null = null;

  function isStale(): boolean {
    return nowFn() - lastFetchMs > ttlMs;
  }

  async function refresh(): Promise<void> {
    // Stamp the ATTEMPT time up front so the cooldown bound holds even when the
    // fetch fails - otherwise a failing/slow AS would let an unknown-kid flood
    // reflect 1:1 into outbound fetches.
    lastAttemptMs = nowFn();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(options.jwksUri, { signal: controller.signal });
      if (!res.ok) {
        throw new JwksError("fetch", `JWKS fetch returned HTTP ${res.status}`);
      }
      // The body read stays UNDER the timeout + abort signal.
      const pairs = parseJwks(await res.json());
      if (pairs.length === 0) {
        // A well-formed-but-empty (or all-unusable) JWKS is treated as a FAILURE,
        // so stale-on-error preserves any existing good cache instead of wiping
        // it. We throw BEFORE clearing the cache.
        throw new JwksError("empty", "JWKS exposes no usable RS256 signing keys");
      }
      // Replace the cache only after a fully successful, non-empty parse.
      cache.clear();
      for (const [kid, pem] of pairs) {
        if (cache.size >= maxKeys) break;
        cache.set(kid, pem);
      }
      lastFetchMs = nowFn();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Refresh if warranted, within a hard rate limit. A refresh happens at most
   * once per `cooldownMs` - measured from the last ATTEMPT (success OR failure)
   * - which bounds an unknown-kid flood even against a failing AS and means an
   * empty cache cannot be hammered. Within that limit we refresh when there is
   * nothing cached, the cache is past its TTL, or the caller asked for a kid we
   * don't have (key rotation). A failed refresh that still leaves a usable cache
   * is swallowed (stale-on-error); a failure with an empty cache propagates.
   */
  async function maybeRefresh(unknownKid: boolean): Promise<void> {
    if (nowFn() - lastAttemptMs < cooldownMs) return; // hard rate limit (attempt-based)

    const stale = nowFn() - lastFetchMs > ttlMs;
    if (!(cache.size === 0 || stale || unknownKid)) return;

    if (inFlight) {
      // Coalesce concurrent misses onto the single in-flight fetch.
      await inFlight.catch(() => undefined);
      return;
    }
    inFlight = refresh();
    try {
      await inFlight;
    } catch (err) {
      if (cache.size === 0) throw err; // nothing to serve -> surface it
      // else: keep serving the existing cache (stale-on-error).
    } finally {
      inFlight = null;
    }
  }

  return {
    async getPublicKeyPem(kid: string | undefined): Promise<string> {
      // Fast path: a known kid in a fresh cache.
      if (kid !== undefined && cache.has(kid) && !isStale()) {
        return cache.get(kid) as string;
      }

      await maybeRefresh(kid !== undefined && !cache.has(kid));

      if (kid !== undefined) {
        const pem = cache.get(kid);
        if (pem === undefined) {
          throw new JwksError("unknown-kid", "No JWKS key matches the token kid");
        }
        return pem;
      }

      // Token without a kid: only unambiguous when the JWKS has exactly one key.
      if (cache.size === 0) {
        throw new JwksError("no-keys", "JWKS has no usable signing keys");
      }
      if (cache.size > 1) {
        throw new JwksError(
          "ambiguous",
          "Token has no kid but the JWKS exposes multiple keys",
        );
      }
      return cache.values().next().value as string;
    },
  };
}
