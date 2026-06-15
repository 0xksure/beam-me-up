/**
 * OAuth Protected Resource Metadata (RFC 9728) + the WWW-Authenticate header
 * (M5). Pure data shaping.
 *
 * buildProtectedResourceMetadata(config) -> the JSON document served at
 *   `/.well-known/oauth-protected-resource`:
 *     { resource: config.resourceUrl,
 *       authorization_servers: [config.issuer],
 *       scopes_supported: config.requiredScopes (omit if empty),
 *       bearer_methods_supported: ["header"],
 *       resource_name: "Beam Me Up MCP server" }
 *
 * wwwAuthenticate(config, opts?) -> the WWW-Authenticate header VALUE for a 401/
 *   403, always pointing the client at the metadata so it can discover the AS:
 *     Bearer resource_metadata="<config.metadataUrl>"
 *   plus error="<opts.error>", error_description="<opts.description>" when given
 *   (e.g. error "invalid_token" / "insufficient_scope"). Values are quoted and
 *   any embedded quotes/backslashes are escaped.
 *
 * STUB (M5 skeleton): the bodies are filled in by the implementer; the
 * signatures + types are final.
 */
import type { OAuthConfig } from "./config.js";

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported: string[];
  resource_name?: string;
};

/**
 * Build the RFC 9728 protected-resource metadata document for this resource
 * server. `scopes_supported` is omitted entirely when no scopes are required.
 */
export function buildProtectedResourceMetadata(
  config: OAuthConfig,
): ProtectedResourceMetadata {
  const metadata: ProtectedResourceMetadata = {
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "Beam Me Up MCP server",
  };
  if (config.requiredScopes.length > 0) {
    metadata.scopes_supported = [...config.requiredScopes];
  }
  return metadata;
}

/**
 * Escape a value to be embedded inside an HTTP `auth-param` quoted-string:
 * backslashes and double-quotes are backslash-escaped (RFC 7235 quoted-string).
 */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the `WWW-Authenticate` header VALUE for a 401/403 response. Always
 * points the client at the protected-resource metadata so it can discover the
 * Authorization Server; appends `error`/`error_description` auth-params when
 * provided. Never includes the token.
 */
export function wwwAuthenticate(
  config: OAuthConfig,
  opts?: { error?: string; description?: string },
): string {
  let header = `Bearer resource_metadata="${escapeQuoted(config.metadataUrl)}"`;
  if (opts?.error !== undefined) {
    header += `, error="${escapeQuoted(opts.error)}"`;
  }
  if (opts?.description !== undefined) {
    header += `, error_description="${escapeQuoted(opts.description)}"`;
  }
  return header;
}
