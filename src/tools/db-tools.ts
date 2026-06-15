/**
 * provisionDatabaseTool - the M2 database provisioning tool handler.
 *
 * Mirrors the M1 deploy tools (src/tools/deploy-tools.ts):
 *   - takes the already-validated args object (parsed against the schema in
 *     server.ts),
 *   - resolves the engine's credentials internally via getDbCredentials,
 *   - picks the provisioner via selectDbProvisioner,
 *   - delegates to DbProvisioner.provision,
 *   - and NEVER throws uncaught: on missing creds, an unsupported engine, or a
 *     provider error it returns a structured { error: string } which the MCP
 *     handler in server.ts turns into an isError result.
 *
 * Contract (see PINNED CONTRACT):
 *   - engine not postgres/redis -> { error: "M2 supports postgres (Neon) and
 *       redis (Upstash) only" }
 *   - getDbCredentials(engine) === null -> { error: <name the missing env
 *       var(s)>: NEON_API_KEY for postgres; UPSTASH_EMAIL + UPSTASH_API_KEY for
 *       redis }
 *   - any provider/runtime error is caught and returned as { error }.
 *   - credentials / connection strings are never logged.
 */
import type { DbEngine, ProvisionResult } from "../adapters/db/interface.js";
import type { ToolError } from "../schemas.js";
import { selectDbProvisioner } from "../adapters/db/registry.js";
import { getDbCredentials } from "../auth/token.js";

/** Message for any engine other than postgres/redis in M2. */
const UNSUPPORTED_ENGINE_MESSAGE =
  "M2 supports postgres (Neon) and redis (Upstash) only.";

/** Message when the Neon (postgres) credential is missing. */
const MISSING_NEON_MESSAGE =
  "No Neon credentials found. Set the NEON_API_KEY environment variable to provision a Postgres database on Neon.";

/** Message when the Upstash (redis) credentials are missing. */
const MISSING_UPSTASH_MESSAGE =
  "No Upstash credentials found. Set the UPSTASH_EMAIL and UPSTASH_API_KEY environment variables to provision a Redis database on Upstash.";

/** Coerce any thrown value into a human-readable error string. */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error while talking to the database provider.";
}

export async function provisionDatabaseTool(args: {
  engine: DbEngine;
  name: string;
  region?: string;
}): Promise<ProvisionResult | ToolError> {
  // Reject unsupported engines before touching creds or the provider. The
  // `engine` field is statically narrowed to "postgres" | "redis" by the zod
  // enum, but we still compare at runtime so a value that slips past validation
  // (or a future widened schema) gets the friendly message instead of an
  // exhaustiveness throw from the registry.
  if (args.engine !== "postgres" && args.engine !== "redis") {
    return { error: UNSUPPORTED_ENGINE_MESSAGE };
  }

  const creds = getDbCredentials(args.engine);
  if (creds === null) {
    return {
      error:
        args.engine === "postgres"
          ? MISSING_NEON_MESSAGE
          : MISSING_UPSTASH_MESSAGE,
    };
  }

  try {
    const provisioner = selectDbProvisioner(args.engine, creds);
    return await provisioner.provision({
      name: args.name,
      region: args.region,
    });
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}
