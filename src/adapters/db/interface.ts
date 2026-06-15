/**
 * DbProvisioner - the pluggable adapter contract for "headlessly create a
 * managed database and hand back its connection-string env vars".
 *
 * This mirrors the M1 DeployTarget pattern (src/adapters/deploy/interface.ts):
 * the provision_database tool (src/tools/db-tools.ts) only ever talks to a
 * DbProvisioner; it never reaches into a provider's REST API directly. The
 * registry (src/adapters/db/registry.ts) hands it the right provisioner for an
 * engine.
 *
 * M2 ships two engines:
 *   - postgres -> Neon    (src/adapters/db/neon)
 *   - redis    -> Upstash (src/adapters/db/upstash)
 *
 * The host AI takes the returned envVars and feeds them into the existing
 * set_env_vars deploy tool.
 */

/** The database engine the caller wants provisioned. */
export type DbEngine = "postgres" | "redis";

/** Credentials for Neon (Postgres). Read from NEON_API_KEY. */
export type NeonCreds = { apiKey: string };

/** Credentials for Upstash (Redis). Read from UPSTASH_EMAIL + UPSTASH_API_KEY. */
export type UpstashCreds = { email: string; apiKey: string };

/**
 * The result of provisioning a database: which provider served it, the
 * provider-side resource id, and the connection-string env vars to push onto
 * the deploy target.
 */
export type ProvisionResult = {
  provider: "neon" | "upstash";
  resourceId: string;
  envVars: Record<string, string>;
};

/**
 * The provider-agnostic database provisioner. A single `provision` call creates
 * (or looks up) the managed instance and returns its connection env vars.
 */
export interface DbProvisioner {
  /** Stable provider id this provisioner implements. */
  readonly provider: "neon" | "upstash";

  /** Create the managed database and return its connection env vars. */
  provision(input: { name: string; region?: string }): Promise<ProvisionResult>;
}
