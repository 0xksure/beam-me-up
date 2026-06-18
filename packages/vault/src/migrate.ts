/**
 * runMigrations — apply the numbered, forward-only SQL files under
 * packages/vault/migrations against a pg Pool.
 *
 * Each file's NNNN prefix is recorded in schema_migrations; a file is applied
 * only when its version is absent from the ledger. The whole run is serialized
 * with a pg_advisory_lock so concurrent hosted instances don't race on boot.
 * Files are idempotent (CREATE … IF NOT EXISTS) and self-transacted.
 *
 * Only the gated integration test exercises this runner; offline runs never
 * import a live Pool.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const ADVISORY_LOCK_KEY = 0x6265616d_76303031n; // "beamv001"

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/migrate.ts and dist/migrate.js both sit one level under packages/vault.
  return join(here, "..", "migrations");
}

type MigrationFile = { version: string; path: string };

function listMigrationFiles(): MigrationFile[] {
  const dir = migrationsDir();
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: f.slice(0, 4), path: join(dir, f) }));
}

export async function runMigrations(pool: Pool): Promise<{ applied: string[] }> {
  const files = listMigrationFiles();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

    // Ensure the ledger exists before we read it (first-ever run).
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const done = new Set(rows.map((r) => r.version));

    for (const file of files) {
      if (done.has(file.version)) continue;
      const sql = readFileSync(file.path, "utf8");
      // The file wraps itself in BEGIN/COMMIT and records its own version.
      await client.query(sql);
      applied.push(file.version);
    }
    return { applied };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/* CLI entrypoint: `npm run vault:migrate`. */
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
    const { makePool } = await import("./pool.js");
    const pool = makePool();
    const { applied } = await runMigrations(pool);
    process.stdout.write(
      applied.length
        ? `vault:migrate applied ${applied.join(", ")}\n`
        : "vault:migrate: nothing to apply\n",
    );
    await pool.end();
  })().catch((err) => {
    process.stderr.write(`vault:migrate failed: ${String(err)}\n`);
    process.exit(1);
  });
}
