/**
 * getOAuthConfig - resolve the HTTP-transport OAuth config from the environment
 * (M5). When it returns null, OAuth is DISABLED and the HTTP server keeps its
 * M0 no-auth localhost behavior (with a startup warning). When it returns a
 * config, the /mcp endpoint requires a verified bearer token.
 *
 * The Beam Me Up server is an OAuth 2.0 *Resource Server*: it does NOT issue
 * tokens, it verifies tokens an external Authorization Server issued. So config
 * is the AS issuer + this resource's identifier + the key material to verify the
 * token signature. No secrets are logged.
 *
 * Env vars (OAuth is ENABLED when issuer + audience + a key are all present):
 *   OAUTH_ISSUER          (req) the AS issuer URL; must match the token `iss`.
 *   OAUTH_AUDIENCE        (req) this resource's identifier; must be in token `aud`.
 *   OAUTH_JWT_SECRET      HS256 shared secret  -> alg "HS256".
 *   OAUTH_JWT_PUBLIC_KEY  RS256 static PEM public key -> alg "RS256".
 *   OAUTH_JWKS_URI        RS256 via JWKS: the AS's JWKS URL (preferred for a
 *                         managed IdP whose signing key rotates) -> alg "RS256".
 *     (a key is required: SECRET (HS256), or PUBLIC_KEY / JWKS_URI (RS256). When
 *      both a secret and an RS256 key are set, SECRET wins. When both PUBLIC_KEY
 *      and JWKS_URI are set, the JWKS endpoint is used. Log nothing either way.)
 *   OAUTH_RESOURCE_URL    (opt) this server's resource URL for the metadata
 *                         `resource` field; defaults to
 *                         `http://localhost:${PORT}/mcp`.
 *   OAUTH_REQUIRED_SCOPES (opt) comma/space-separated scopes every token must have.
 *   OAUTH_JWT_ALG         (opt) override "HS256"|"RS256" (else inferred from which
 *                         key is set).
 *
 * metadataUrl is derived as `<origin of resourceUrl>/.well-known/oauth-protected-resource`.
 *
 * STUB (M5 skeleton): the body is filled in by the implementer; the signature +
 * the OAuthConfig type are final.
 */

/** Resolved OAuth config for the Resource Server. */
export type OAuthConfig = {
  /** AS issuer URL; the token `iss` must equal this. */
  issuer: string;
  /** This resource's identifier; must appear in the token `aud`. */
  audience: string;
  /** This server's resource URL (the metadata `resource` value). */
  resourceUrl: string;
  /** Signature algorithm of the access tokens. */
  alg: "HS256" | "RS256";
  /** HS256 shared secret (present iff alg === "HS256"). */
  secret?: string;
  /** RS256 static PEM public key (RS256 only; used when no jwksUri is set). */
  publicKeyPem?: string;
  /** RS256 JWKS endpoint (RS256 only; takes precedence over publicKeyPem). */
  jwksUri?: string;
  /** Scopes every token must carry (may be empty). */
  requiredScopes: string[];
  /** Absolute URL of the protected-resource metadata document. */
  metadataUrl: string;
  /** Path of the protected-resource metadata (e.g. "/.well-known/oauth-protected-resource"). */
  metadataPath: string;
};

/** Trim a value, returning undefined for missing/blank strings. */
function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

export function getOAuthConfig(): OAuthConfig | null {
  const env = process.env;

  const issuer = trimmed(env.OAUTH_ISSUER);
  const audience = trimmed(env.OAUTH_AUDIENCE);
  const secret = trimmed(env.OAUTH_JWT_SECRET);
  const publicKeyPem = trimmed(env.OAUTH_JWT_PUBLIC_KEY);
  const jwksUri = trimmed(env.OAUTH_JWKS_URI);

  // ENABLED iff issuer && audience && a key (HS256 secret, or RS256 PEM/JWKS).
  if (!issuer || !audience || !(secret || publicKeyPem || jwksUri)) {
    return null;
  }

  // alg: explicit override wins; else HS256 when a secret is present, else RS256.
  const algOverride = trimmed(env.OAUTH_JWT_ALG);
  const alg: "HS256" | "RS256" =
    algOverride === "HS256" || algOverride === "RS256"
      ? algOverride
      : secret
        ? "HS256"
        : "RS256";

  // resourceUrl: explicit override, else http://localhost:${PORT}/mcp (default 3000).
  const port = trimmed(env.PORT) ?? "3000";
  const resourceUrl =
    trimmed(env.OAUTH_RESOURCE_URL) ?? `http://localhost:${port}/mcp`;

  // requiredScopes: split on comma/whitespace, drop empties.
  const requiredScopes = (trimmed(env.OAUTH_REQUIRED_SCOPES) ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const metadataPath = "/.well-known/oauth-protected-resource";
  const metadataUrl = new URL(metadataPath, resourceUrl).toString();

  // SECRET wins if both are set; only carry the key material for the chosen alg.
  // For RS256, a JWKS endpoint takes precedence over a static PEM.
  return {
    issuer,
    audience,
    resourceUrl,
    alg,
    secret: alg === "HS256" ? secret : undefined,
    publicKeyPem: alg === "RS256" ? publicKeyPem : undefined,
    jwksUri: alg === "RS256" ? jwksUri : undefined,
    requiredScopes,
    metadataUrl,
    metadataPath,
  };
}
