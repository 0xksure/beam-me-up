/**
 * TokenVerifier (M5) — turns a raw bearer token into AuthInfo, or throws an
 * AuthError the HTTP layer maps to a 401/403.
 *
 * createJwtVerifier(config) returns a TokenVerifier that:
 *   - calls verifyJwt(token, { alg, secret/publicKeyPem, issuer, audience })
 *     (src/auth/oauth/jwt.ts); any JwtError -> AuthError("invalid_token", 401).
 *   - extracts scopes (from `scope` space-split, or `scp[]`).
 *   - enforces config.requiredScopes: if any is missing ->
 *     AuthError("insufficient_scope", 403).
 *   - returns AuthInfo { subject: claims.sub, scopes, expiresAt: claims.exp,
 *     clientId: claims.client_id, claims }.
 *
 * STUB (M5 skeleton): the bodies are filled in by the implementer; the
 * signatures + types are final.
 */
import type { OAuthConfig } from "./config.js";
import type { JwtClaims } from "./jwt.js";
import { verifyJwt, decodeJwtHeader, JwtError } from "./jwt.js";
import { createJwksResolver, JwksError, type JwksResolver } from "./jwks.js";

export type AuthInfo = {
  subject?: string;
  scopes: string[];
  expiresAt?: number;
  clientId?: string;
  claims: JwtClaims;
};

/** Maps to an HTTP 401 (missing/invalid_token) or 403 (insufficient_scope). */
export class AuthError extends Error {
  readonly code: "missing_token" | "invalid_token" | "insufficient_scope";
  readonly status: 401 | 403;
  readonly description: string;
  constructor(
    code: "missing_token" | "invalid_token" | "insufficient_scope",
    description: string,
  ) {
    super(description);
    this.name = "AuthError";
    this.code = code;
    this.status = code === "insufficient_scope" ? 403 : 401;
    this.description = description;
  }
}

export interface TokenVerifier {
  /** Verify a raw access token; resolve to AuthInfo or reject with AuthError. */
  verify(token: string): Promise<AuthInfo>;
}

/**
 * Collect the scopes carried by a token. Two conventions are merged:
 *   - `scope`: a single space-delimited string (RFC 8693 / OAuth);
 *   - `scp`:   an array of scope strings (used by some Authorization Servers).
 * Values are trimmed and empties dropped; the result preserves first-seen order
 * with duplicates removed so membership checks are stable.
 */
function extractScopes(claims: JwtClaims): string[] {
  const scopes: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const scope = raw.trim();
    if (scope.length === 0 || seen.has(scope)) return;
    seen.add(scope);
    scopes.push(scope);
  };

  if (typeof claims.scope === "string") {
    for (const part of claims.scope.split(" ")) add(part);
  }
  if (Array.isArray(claims.scp)) {
    for (const part of claims.scp) {
      if (typeof part === "string") add(part);
    }
  }
  return scopes;
}

/**
 * Build a TokenVerifier bound to a resolved OAuthConfig.
 *
 * `verify(token)` delegates signature + claim checks to verifyJwt(); any
 * JwtError is normalized to AuthError("invalid_token", 401) so the token-shape
 * details never leak past this boundary. After a valid token is decoded, the
 * configured `requiredScopes` are enforced — a missing scope yields
 * AuthError("insufficient_scope", 403). The raw token is never logged.
 *
 * When the config has a `jwksUri` (RS256 via a managed Authorization Server),
 * the RS256 public key is resolved by the token's header `kid` from the JWKS
 * endpoint (rotating keys) instead of a static PEM. The algorithm stays pinned
 * to RS256 — key SELECTION by `kid` never weakens verifyJwt's alg-confusion
 * guard. A JWKS resolution failure maps to AuthError("invalid_token", 401), so
 * the server never fails open. `deps.jwksResolver` is injectable for tests.
 */
export function createJwtVerifier(
  config: OAuthConfig,
  deps?: { jwksResolver?: JwksResolver },
): TokenVerifier {
  const useJwks =
    config.alg === "RS256" &&
    typeof config.jwksUri === "string" &&
    config.jwksUri.length > 0;
  const jwksResolver: JwksResolver | undefined = useJwks
    ? (deps?.jwksResolver ??
      createJwksResolver({ jwksUri: config.jwksUri as string, issuer: config.issuer }))
    : undefined;

  return {
    async verify(token: string): Promise<AuthInfo> {
      let claims: JwtClaims;
      try {
        if (jwksResolver) {
          const header = decodeJwtHeader(token);
          const kid = typeof header.kid === "string" ? header.kid : undefined;
          const publicKeyPem = await jwksResolver.getPublicKeyPem(kid);
          claims = verifyJwt(token, {
            alg: "RS256",
            publicKeyPem,
            issuer: config.issuer,
            audience: config.audience,
          });
        } else {
          claims = verifyJwt(token, {
            alg: config.alg,
            secret: config.secret,
            publicKeyPem: config.publicKeyPem,
            issuer: config.issuer,
            audience: config.audience,
          });
        }
      } catch (err) {
        if (err instanceof JwtError || err instanceof JwksError) {
          throw new AuthError("invalid_token", err.message);
        }
        throw err;
      }

      const scopes = extractScopes(claims);
      const missing = config.requiredScopes.filter(
        (required) => !scopes.includes(required),
      );
      if (missing.length > 0) {
        throw new AuthError(
          "insufficient_scope",
          `Missing required scope(s): ${missing.join(" ")}`,
        );
      }

      return {
        subject: claims.sub,
        scopes,
        expiresAt: claims.exp,
        clientId: claims.client_id,
        claims,
      };
    },
  };
}
