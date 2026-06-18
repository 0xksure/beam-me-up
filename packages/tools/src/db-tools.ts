/**
 * provisionDatabaseTool - the M2 database provisioning tool handler.
 *
 * Mirrors the M1 deploy tools (src/deploy-tools.ts):
 *   - takes the already-validated args object,
 *   - resolves the engine's credentials internally via getDbCredentials,
 *   - picks the provisioner via selectDbProvisioner,
 *   - delegates to DbProvisioner.provision,
 *   - and NEVER throws uncaught.
 *
 * M9 P3a — ctx-aware behaviour on the per-user path:
 *   - NEEDS-CONNECT: null creds + `ctx` -> a `needsConnect` envelope (database
 *     role, one-click Connect copy) — NEVER "set the NEON_API_KEY…". On the
 *     no-`ctx` self-host path the env-var message is retained verbatim.
 *   - DESTINATION CONFIRMATION: provision_database STOPs and returns
 *     `needsConfirmation` (NO side effect) unless a valid HMAC `confirmToken`
 *     is present, echoing the database account label (free-tier note) from the
 *     vault connection.
 */
import type {
  DbEngine,
  ProvisionResult,
  CredentialContext,
} from "@beam-me-up/adapters";
import type {
  HostDirective,
  NeedsConfirmationResult,
  NeedsConnectResult,
  ProviderName,
  ToolError,
} from "@beam-me-up/core";

/** The provision success output, additively carrying the ctx-path UX fields. */
type ProvisionOutput = ProvisionResult & {
  costSoFar?: "$0";
  host?: HostDirective;
};
import { selectDbProvisioner } from "@beam-me-up/adapters";
import { getDbCredentials } from "@beam-me-up/adapters";
import {
  buildNeedsConnect,
  confirmationGate,
  destinationLabelFor,
  needsConnectFor,
  providerDisplayName,
  readConnections,
} from "./ux/index.js";

/** Message for any engine other than postgres/redis in M2. */
const UNSUPPORTED_ENGINE_MESSAGE =
  "M2 supports postgres (Neon) and redis (Upstash) only.";

/** Message when the Neon (postgres) credential is missing (no-ctx path only). */
const MISSING_NEON_MESSAGE =
  "No Neon credentials found. Set the NEON_API_KEY environment variable to provision a Postgres database on Neon.";

/** Message when the Upstash (redis) creds are missing (no-ctx path only). */
const MISSING_UPSTASH_MESSAGE =
  "No Upstash credentials found. Set the UPSTASH_EMAIL and UPSTASH_API_KEY environment variables to provision a Redis database on Upstash.";

/** Map a DB engine to the provider name stored in the vault. */
function engineProvider(engine: "postgres" | "redis"): ProviderName {
  return engine === "postgres" ? "neon" : "upstash";
}

/** Coerce any thrown value into a human-readable error string. */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error while talking to the database provider.";
}

export async function provisionDatabaseTool(
  args: {
    engine: DbEngine;
    name: string;
    region?: string;
    confirmToken?: string;
  },
  ctx?: CredentialContext,
): Promise<
  ProvisionOutput | ToolError | NeedsConnectResult | NeedsConfirmationResult
> {
  if (args.engine !== "postgres" && args.engine !== "redis") {
    return { error: UNSUPPORTED_ENGINE_MESSAGE };
  }

  const provider = engineProvider(args.engine);

  if (ctx) {
    // ctx path: needs-connect check, then the destination-confirmation gate.
    const connections = await readConnections(ctx);
    const connect = needsConnectFor(connections, provider);
    if (connect) return connect;

    const destinations = [destinationLabelFor(connections, provider, true)];
    const gate = confirmationGate({
      tool: "provision_database",
      subject: ctx.subject,
      resourceName: args.name,
      args: args as unknown as Record<string, unknown>,
      destinations,
    });
    if (gate) return gate;
  }

  const creds = await getDbCredentials(args.engine, ctx);
  if (creds === null) {
    if (ctx) {
      // ctx path: never name env vars — surface as needsConnect.
      return buildNeedsConnect({ provider, reason: "no_connection" });
    }
    return {
      error:
        args.engine === "postgres"
          ? MISSING_NEON_MESSAGE
          : MISSING_UPSTASH_MESSAGE,
    };
  }

  try {
    const provisioner = selectDbProvisioner(args.engine, creds);
    const result = await provisioner.provision({
      name: args.name,
      region: args.region,
    });
    if (ctx) {
      const name = providerDisplayName(provider);
      return {
        ...result,
        costSoFar: "$0",
        host: {
          speak:
            `Done! Your free database is ready on ${name}. It’s on the free ` +
            "tier, so this costs $0 — I’ll warn you long before anything could " +
            "ever cost money. Cost so far: $0.",
          buttons: [],
        },
      };
    }
    return result;
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}
