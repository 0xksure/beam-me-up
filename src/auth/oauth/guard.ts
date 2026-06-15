/**
 * OAuthGuard (M5) — the transport-agnostic seam that ties config + verifier +
 * metadata together so the HTTP server (src/server/http.ts) stays thin and the
 * authorization logic is unit-testable WITHOUT starting a server.
 *
 * resolveOAuthGuard(): reads getOAuthConfig(); returns null when OAuth is
 *   disabled, else an OAuthGuard built from createJwtVerifier(config) +
 *   buildProtectedResourceMetadata(config).
 *
 * guard.authorize(authorizationHeader):
 *   - no/empty header, or not "Bearer <token>" -> { ok:false, status:401,
 *     wwwAuthenticate: wwwAuthenticate(config), body:{ error:"missing_token",
 *     error_description:"..." } }.
 *   - else verifier.verify(token): on AuthError -> { ok:false, status:err.status,
 *     wwwAuthenticate: wwwAuthenticate(config, { error:err.code,
 *     description:err.description }), body:{ error:err.code, error_description } };
 *     on success -> { ok:true, auth }.
 *   Bearer scheme match is case-insensitive; never logs the token.
 *
 * STUB (M5 skeleton): the bodies are filled in by the implementer; the
 * signatures + types are final.
 */
import { getOAuthConfig, type OAuthConfig } from "./config.js";
import {
  buildProtectedResourceMetadata,
  wwwAuthenticate,
  type ProtectedResourceMetadata,
} from "./metadata.js";
import { AuthError, createJwtVerifier, type AuthInfo } from "./verifier.js";

export type AuthorizeResult =
  | { ok: true; auth: AuthInfo }
  | {
      ok: false;
      status: number;
      wwwAuthenticate: string;
      body: { error: string; error_description: string };
    };

export type OAuthGuard = {
  config: OAuthConfig;
  metadata: ProtectedResourceMetadata;
  /** Path the metadata is served at, e.g. "/.well-known/oauth-protected-resource". */
  metadataPath: string;
  authorize(authorizationHeader: string | undefined): Promise<AuthorizeResult>;
};

export function resolveOAuthGuard(): OAuthGuard | null {
  const config = getOAuthConfig();
  if (config === null) {
    return null;
  }

  const verifier = createJwtVerifier(config);
  const metadata = buildProtectedResourceMetadata(config);
  const metadataPath = config.metadataPath;

  return {
    config,
    metadata,
    metadataPath,
    async authorize(
      authorizationHeader: string | undefined,
    ): Promise<AuthorizeResult> {
      const header = authorizationHeader?.trim() ?? "";
      // Case-insensitive "Bearer " scheme match with a non-empty token.
      const token = header.slice(7).trim();
      if (header.slice(0, 7).toLowerCase() !== "bearer " || token.length === 0) {
        return {
          ok: false,
          status: 401,
          wwwAuthenticate: wwwAuthenticate(config),
          body: {
            error: "missing_token",
            error_description:
              "A bearer token is required in the Authorization header.",
          },
        };
      }

      try {
        const auth = await verifier.verify(token);
        return { ok: true, auth };
      } catch (err) {
        if (err instanceof AuthError) {
          return {
            ok: false,
            status: err.status,
            wwwAuthenticate: wwwAuthenticate(config, {
              error: err.code,
              description: err.description,
            }),
            body: { error: err.code, error_description: err.description },
          };
        }
        throw err;
      }
    },
  };
}
