/**
 * getProviderToken - resolve a provider's credentials from the environment.
 *
 * M1 only wires Vercel via env vars (full remote OAuth is a later milestone):
 *   - VERCEL_TOKEN    (required) the API token
 *   - VERCEL_TEAM_ID  (optional) team/org scope
 *
 * Returns null when the required token is absent so callers can surface a
 * helpful "set VERCEL_TOKEN" message instead of throwing. The token value is
 * never logged here.
 *
 * M2 adds getDbCredentials (below) for the database provisioners (Neon /
 * Upstash). It follows the same env-var pattern and returns null on a missing
 * credential so the provision_database tool can name the missing var.
 */
import type { ProviderToken } from "./deploy/interface.js";
import type {
  DbEngine,
  NeonCreds,
  UpstashCreds,
} from "./db/interface.js";

/**
 * CredentialContext (M9 P1) — the per-user identity SEAM.
 *
 * When a request is authenticated (OAuth bearer), the HTTP layer can build a
 * CredentialContext keyed on the JWT subject and thread it through the tools so
 * credentials resolve PER USER instead of from the server's process.env. M9 P1
 * only establishes the seam: the resolvers below delegate to ctx when present
 * and otherwise keep the existing env reads, so stdio / no-auth loopback are
 * unchanged. The credential VAULT that ctx.resolve/resolveDb consults is a later
 * phase (P2); here ctx is supplied only by tests.
 */
export type CredentialContext = {
  subject: string;
  resolve(provider: "vercel" | "digitalocean"): ProviderToken | null;
  resolveDb(engine: DbEngine): NeonCreds | UpstashCreds | null;
};

export function getProviderToken(
  provider: "vercel" | "digitalocean",
  ctx?: CredentialContext,
): ProviderToken | null {
  // Per-user resolution wins when an identity context is present (P2 vault).
  if (ctx) return ctx.resolve(provider);
  switch (provider) {
    case "vercel": {
      const token = process.env.VERCEL_TOKEN?.trim();
      if (!token) return null;
      const teamId = process.env.VERCEL_TEAM_ID?.trim();
      return teamId ? { token, teamId } : { token };
    }
    case "digitalocean": {
      // M4: DigitalOcean credentials. Not wired in M1.
      const token = process.env.DIGITALOCEAN_TOKEN?.trim();
      if (!token) return null;
      return { token };
    }
    default:
      return null;
  }
}

/**
 * getDbCredentials - resolve a database engine's credentials from the
 * environment (M2). No OAuth: creds come straight from env vars.
 *
 *   - postgres (Neon):    NEON_API_KEY                  -> { apiKey }
 *   - redis    (Upstash): UPSTASH_EMAIL + UPSTASH_API_KEY -> { email, apiKey }
 *
 * Returns null when a required credential is absent so provision_database can
 * surface a helpful "set NEON_API_KEY" (or the Upstash pair) message instead of
 * throwing. Credential values are never logged here.
 */
export function getDbCredentials(
  engine: DbEngine,
  ctx?: CredentialContext,
): NeonCreds | UpstashCreds | null {
  // Per-user resolution wins when an identity context is present (P2 vault).
  if (ctx) return ctx.resolveDb(engine);
  switch (engine) {
    case "postgres": {
      const apiKey = process.env.NEON_API_KEY?.trim();
      if (!apiKey) return null;
      return { apiKey };
    }
    case "redis": {
      const email = process.env.UPSTASH_EMAIL?.trim();
      const apiKey = process.env.UPSTASH_API_KEY?.trim();
      if (!email || !apiKey) return null;
      return { email, apiKey };
    }
    default:
      return null;
  }
}
