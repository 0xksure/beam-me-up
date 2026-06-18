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
 * unchanged. The credential VAULT that ctx.resolve/resolveDb consults is wired
 * in P2c.
 *
 * The resolvers are ASYNC (the vault store hits Postgres + KMS), so resolve /
 * resolveDb return Promises and every call site awaits getProviderToken /
 * getDbCredentials. The no-ctx env path returns the same resolved values it
 * always did — behaviour with no ctx is identical.
 */
/**
 * A non-secret connection summary the UX layer reads to (a) echo the
 * destination account/team label in the confirmation gate and (b) decide
 * whether a provider is connected / expired / revoked for the needsConnect +
 * recovery copy. It is a structural subset of the vault's ConnectionSummary
 * (no plaintext token); `providerAccountId` is the account label captured at
 * Connect time (richer team labels arrive with the P3b connect surface).
 */
export type ConnectionInfo = {
  provider: "vercel" | "digitalocean" | "github" | "neon" | "upstash";
  /** '' when the provider has no account id. */
  providerAccountId: string;
  status: "active" | "expired" | "revoked";
};

export type CredentialContext = {
  subject: string;
  resolve(provider: "vercel" | "digitalocean"): Promise<ProviderToken | null>;
  resolveDb(engine: DbEngine): Promise<NeonCreds | UpstashCreds | null>;
  /**
   * M9 P3a: this subject's connection summaries (NO plaintext tokens), so the
   * UX layer can echo the destination account label in the confirmation gate
   * and pick the right needsConnect / recovery copy. Optional so older
   * contexts (and the env path) keep type-checking; when absent the UX layer
   * falls back to a neutral label.
   */
  listConnections?(): Promise<ConnectionInfo[]>;
};

export async function getProviderToken(
  provider: "vercel" | "digitalocean",
  ctx?: CredentialContext,
): Promise<ProviderToken | null> {
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
export async function getDbCredentials(
  engine: DbEngine,
  ctx?: CredentialContext,
): Promise<NeonCreds | UpstashCreds | null> {
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
