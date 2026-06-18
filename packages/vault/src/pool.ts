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
  /** "require" enables TLS (rejectUnauthorized:false to allow managed CAs). */
  ssl?: string;
}

export function makePool(opts: MakePoolOptions = {}): Pool {
  if (singleton) return singleton;
  const connectionString = opts.connectionString ?? process.env.BEAM_VAULT_DATABASE_URL;
  if (!connectionString) {
    throw new Error("BEAM_VAULT_DATABASE_URL is required to build the vault pool.");
  }
  const sslMode = opts.ssl ?? process.env.BEAM_VAULT_PG_SSL;
  singleton = new Pool({
    connectionString,
    ssl: sslMode === "require" ? { rejectUnauthorized: false } : undefined,
  });
  return singleton;
}

/** Test helper: drop the cached singleton so a fresh pool can be built. */
export function resetPoolForTests(): void {
  singleton = undefined;
}
