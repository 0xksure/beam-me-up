/**
 * CredentialStore — the per-user credential vault contract.
 *
 * Keyed on Subject = { issuer, sub }. Implementations find-or-create the users
 * row, envelope-seal on write, decrypt on read, and (for OAuth providers)
 * refresh access tokens on near-expiry. Two implementations share this
 * interface: InMemoryCredentialStore (tests) and PgCredentialStore (real pg).
 *
 * The provider type set spans deploy providers (vercel / digitalocean / github)
 * and DB engines (neon / upstash). getProviderToken returns the adapters'
 * ProviderToken; getDbCredentials returns NeonCreds | UpstashCreds.
 */
import type {
  ProviderToken,
  DbEngine,
  NeonCreds,
  UpstashCreds,
} from "@beam-me-up/adapters";
import type { Subject } from "./subject.js";

/** OAuth deploy providers (have a refresh path). */
export type Provider = "vercel" | "digitalocean" | "github";

/** DB-engine providers (paste-a-key, no refresh path). */
export type DbProviderName = "neon" | "upstash";

/** Any provider stored in provider_connections. */
export type AnyProvider = Provider | DbProviderName;

export type ConnectionStatus = "active" | "expired" | "revoked";

/** A connection row WITHOUT any plaintext token (for listings / UI). */
export type ConnectionSummary = {
  provider: AnyProvider;
  /** '' when the provider has no account id. */
  providerAccountId: string;
  scopes: string[];
  status: ConnectionStatus;
  /** epoch seconds, or null when unknown / non-expiring. */
  accessTokenExpiresAt: number | null;
  /** epoch seconds. */
  updatedAt: number;
};

export type UpsertConnectionInput = {
  subject: Subject;
  provider: AnyProvider;
  /** Defaults to ''. */
  providerAccountId?: string;
  scopes: string[];
  accessToken: string;
  refreshToken?: string | null;
  /** epoch seconds. */
  accessTokenExpiresAt?: number | null;
  refreshTokenExpiresAt?: number | null;
};

/**
 * Per-provider refresh function, injected so refresh-on-expiry is testable
 * offline. Returns the new tokens, or { reuseDetected: true } when the provider
 * reports refresh-token reuse (the connection must then be revoked).
 */
export type ProviderRefreshFn = (refreshToken: string) => Promise<
  | {
      accessToken: string;
      refreshToken?: string;
      accessTokenExpiresAt?: number;
      refreshTokenExpiresAt?: number;
    }
  | { reuseDetected: true }
>;

export interface CredentialStore {
  /**
   * Read + decrypt the ACTIVE provider connection for (subject, provider) and
   * refresh-on-near-expiry (skew ~60s) before returning. Returns null when
   * there is no active connection. On a refused / reuse-detected refresh, marks
   * status='revoked' and returns null.
   */
  getProviderToken(subject: Subject, provider: Provider): Promise<ProviderToken | null>;

  /**
   * Same contract for DB engines. 'postgres' -> Neon creds, 'redis' -> Upstash
   * creds. Paste-a-key rows have no refresh path: decrypt and return.
   */
  getDbCredentials(
    subject: Subject,
    engine: DbEngine,
  ): Promise<NeonCreds | UpstashCreds | null>;

  /**
   * Find-or-create the users row (by issuer+sub), envelope-seal the tokens, and
   * UPSERT provider_connections (ON CONFLICT (user_id, provider,
   * provider_account_id) DO UPDATE). Sets status='active'. Idempotent on the
   * unique key.
   */
  upsertConnection(input: UpsertConnectionInput): Promise<void>;

  /** This subject's connections (NO plaintext tokens). */
  listConnections(subject: Subject): Promise<ConnectionSummary[]>;

  /**
   * Disconnect: hard-delete the row (or mark status='revoked'). Idempotent: ok
   * even if no row exists.
   */
  revoke(subject: Subject, provider: AnyProvider): Promise<void>;
}

/** Map a DbEngine to the provider name stored in provider_connections. */
export function dbEngineToProvider(engine: DbEngine): DbProviderName {
  return engine === "postgres" ? "neon" : "upstash";
}
