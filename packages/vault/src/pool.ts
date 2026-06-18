/**
 * makePool — a process-singleton pg Pool against the Beam-OWNED metadata DB.
 *
 * Reads BEAM_VAULT_DATABASE_URL (NOT a user-provisioned DB) and BEAM_VAULT_PG_SSL
 * ("require" -> TLS). Only the gated integration test constructs a real pool;
 * offline runs never touch this.
 */
import { Pool } from "pg";

let singleton: Pool | undefined;

export interface MakePoolOptions {
  connectionString?: string;
  /**
   * TLS mode for the connection to the credential metadata DB:
   *   - "require"          -> TLS with FULL server-certificate verification
   *                           (the secure default). Supply the managed provider's
   *                           CA via BEAM_VAULT_PG_CA (PEM) when it is not in
   *                           Node's trust store (e.g. DigitalOcean / Neon).
   *   - "require-insecure" -> TLS WITHOUT certificate verification. MITM-able, so
   *                           it is FORBIDDEN on the hosted tier (BEAM_TIER=hosted).
   *   - unset / other      -> no TLS (local plaintext development only).
   */
  ssl?: string;
  /** PEM CA bundle used to verify the server certificate when ssl === "require". */
  ca?: string;
  /** Deployment tier; "hosted" forbids the insecure TLS mode. */
  tier?: string;
}

/**
 * Resolve the pg `ssl` option. This is the single most credential-sensitive
 * connection in the system (it carries every user's wrapped DEKs + ciphertext),
 * so it verifies the server certificate by default and only drops verification
 * behind an explicit opt-out that is refused on the hosted tier.
 */
function resolveSsl(
  opts: MakePoolOptions,
): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = opts.ssl ?? process.env.BEAM_VAULT_PG_SSL;
  if (!mode) return false; // no TLS — local plaintext dev only
  if (mode === "require-insecure") {
    const tier = opts.tier ?? process.env.BEAM_TIER;
    if (tier === "hosted") {
      throw new Error(
        "BEAM_VAULT_PG_SSL=require-insecure is forbidden on the hosted tier; " +
          "use 'require' with a verified CA (BEAM_VAULT_PG_CA).",
      );
    }
    return { rejectUnauthorized: false };
  }
  // "require" (and any other truthy value) -> verify the server certificate.
  const ca = opts.ca ?? process.env.BEAM_VAULT_PG_CA;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

export function makePool(opts: MakePoolOptions = {}): Pool {
  if (singleton) return singleton;
  const connectionString = opts.connectionString ?? process.env.BEAM_VAULT_DATABASE_URL;
  if (!connectionString) {
    throw new Error("BEAM_VAULT_DATABASE_URL is required to build the vault pool.");
  }
  singleton = new Pool({ connectionString, ssl: resolveSsl(opts) });
  return singleton;
}

/** Test helper: drop the cached singleton so a fresh pool can be built. */
export function resetPoolForTests(): void {
  singleton = undefined;
}
