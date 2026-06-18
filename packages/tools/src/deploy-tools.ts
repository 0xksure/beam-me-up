/**
 * The four deploy tool handler functions (Vercel + DigitalOcean).
 *
 * Each tool:
 *   - takes the already-validated args object (parsed against the schema in
 *     server.ts),
 *   - resolves the provider token internally via getProviderToken,
 *   - picks the adapter via selectAdapter (vercel -> Vercel, digitalocean ->
 *     DigitalOcean App Platform),
 *   - delegates to the matching DeployTarget method,
 *   - and NEVER throws uncaught: on a missing token, an unknown provider, or a
 *     provider error it returns a structured envelope the MCP handler turns
 *     into the right result.
 *
 * M9 P3a — two ctx-aware behaviours wrap the side effect on the per-user path:
 *   - NEEDS-CONNECT: when the vault has no USABLE connection for
 *     (subject, provider) the tool returns a `needsConnect` envelope with
 *     plain-language copy + a /connect/<provider> button — NEVER "set the
 *     VERCEL_TOKEN…". On the no-`ctx` self-host path the env-var message is
 *     retained verbatim (that audience wants it).
 *   - DESTINATION CONFIRMATION: the creating/mutating tools
 *     (create_deploy_target / deploy / set_env_vars) STOP and return
 *     `needsConfirmation` (NO side effect) unless a valid HMAC `confirmToken`
 *     is present, echoing the destination account label read from the vault.
 *     get_deploy_logs (read-only) does NOT gate.
 */
import type {
  CreateDeployTargetInput,
  CreateDeployTargetOutput,
  DeployInput,
  DeployOutput,
  GetDeployLogsInput,
  GetDeployLogsOutput,
  NeedsConfirmationResult,
  NeedsConnectResult,
  ProviderName,
  SetEnvVarsInput,
  SetEnvVarsOutput,
  ToolError,
} from "@beam-me-up/core";
import type { DeployTarget, CredentialContext } from "@beam-me-up/adapters";
import { selectAdapter } from "@beam-me-up/adapters";
import { getProviderToken } from "@beam-me-up/adapters";
import {
  confirmationGate,
  deploySuccessHost,
  destinationLabelFor,
  needsConnectFor,
  readConnections,
} from "./ux/index.js";

/** Friendly "set your token" message per provider (no-ctx self-host path only). */
function missingTokenMessage(provider: "vercel" | "digitalocean"): string {
  return provider === "vercel"
    ? "No Vercel token found. Set the VERCEL_TOKEN environment variable (and optionally VERCEL_TEAM_ID) to deploy to Vercel."
    : "No DigitalOcean token found. Set the DIGITALOCEAN_TOKEN environment variable to deploy to DigitalOcean App Platform.";
}

/**
 * Resolve the adapter for a tool call, or return a { error } envelope.
 *
 * On the no-`ctx` (self-host) path a missing token still returns the env-var
 * message. On the `ctx` (per-user) path the caller has ALREADY run the
 * needs-connect check, so a null here means the connection vanished mid-call —
 * still surfaced without naming env vars.
 */
async function resolveAdapter(
  provider: string,
  ctx?: CredentialContext,
): Promise<DeployTarget | ToolError | NeedsConnectResult> {
  if (provider !== "vercel" && provider !== "digitalocean") {
    return {
      error: `Unknown provider "${provider}". Use "vercel" or "digitalocean".`,
    };
  }
  const token = await getProviderToken(provider, ctx);
  if (token === null) {
    if (ctx) {
      // ctx path: never name env vars — re-surface as needsConnect.
      return needsConnectFor([], provider) as NeedsConnectResult;
    }
    return { error: missingTokenMessage(provider) };
  }
  return selectAdapter(provider, token);
}

/** Narrow the resolveAdapter result to a ToolError. */
function isToolError(value: unknown): value is ToolError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ToolError).error === "string"
  );
}

/** Narrow to a needsConnect envelope. */
function isNeedsConnect(value: unknown): value is NeedsConnectResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "needsConnect"
  );
}

/** Coerce any thrown value into a human-readable error string. */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error while talking to the deploy provider.";
}

/** The deploy providers as ProviderName (github is not a deploy target). */
function asProviderName(provider: "vercel" | "digitalocean"): ProviderName {
  return provider;
}

/**
 * Run the shared ctx-aware preamble for a creating/mutating deploy tool:
 *   1. needs-connect check (no usable connection -> needsConnect)
 *   2. destination-confirmation gate (no valid confirmToken -> needsConfirmation)
 * Returns a non-`ok` envelope to short-circuit, or null to proceed.
 */
async function ctxGate(opts: {
  ctx: CredentialContext;
  provider: "vercel" | "digitalocean";
  tool: string;
  resourceName: string;
  args: Record<string, unknown>;
}): Promise<NeedsConnectResult | NeedsConfirmationResult | null> {
  const provider = asProviderName(opts.provider);
  const connections = await readConnections(opts.ctx);

  const connect = needsConnectFor(connections, provider);
  if (connect) return connect;

  const destinations = [destinationLabelFor(connections, provider)];
  const confirm = confirmationGate({
    tool: opts.tool,
    subject: opts.ctx.subject,
    resourceName: opts.resourceName,
    args: opts.args,
    destinations,
  });
  return confirm; // needsConfirmation, or null to proceed
}

export async function createDeployTarget(
  args: CreateDeployTargetInput,
  ctx?: CredentialContext,
): Promise<
  CreateDeployTargetOutput | ToolError | NeedsConnectResult | NeedsConfirmationResult
> {
  if (args.provider !== "vercel" && args.provider !== "digitalocean") {
    return { error: `Unknown provider "${args.provider}". Use "vercel" or "digitalocean".` };
  }
  if (ctx) {
    const gate = await ctxGate({
      ctx,
      provider: args.provider,
      tool: "create_deploy_target",
      resourceName: args.projectName,
      args: args as unknown as Record<string, unknown>,
    });
    if (gate) return gate;
  }

  const adapter = await resolveAdapter(args.provider, ctx);
  if (isNeedsConnect(adapter)) return adapter;
  if (isToolError(adapter)) return adapter;
  try {
    const { targetId, dashboardUrl } = await adapter.createProject({
      name: args.projectName,
      framework: args.framework,
    });
    const out: CreateDeployTargetOutput = { provider: adapter.id, targetId, dashboardUrl };
    if (ctx) {
      out.costSoFar = "$0";
      out.host = deploySuccessHost({ resourceName: args.projectName });
    }
    return out;
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}

export async function setEnvVarsTool(
  args: SetEnvVarsInput,
  ctx?: CredentialContext,
): Promise<
  SetEnvVarsOutput | ToolError | NeedsConnectResult | NeedsConfirmationResult
> {
  if (args.provider !== "vercel" && args.provider !== "digitalocean") {
    return { error: `Unknown provider "${args.provider}". Use "vercel" or "digitalocean".` };
  }
  if (ctx) {
    const gate = await ctxGate({
      ctx,
      provider: args.provider,
      tool: "set_env_vars",
      resourceName: args.targetId,
      args: args as unknown as Record<string, unknown>,
    });
    if (gate) return gate;
  }

  const adapter = await resolveAdapter(args.provider, ctx);
  if (isNeedsConnect(adapter)) return adapter;
  if (isToolError(adapter)) return adapter;
  try {
    const result = await adapter.setEnvVars({
      targetId: args.targetId,
      vars: args.vars,
    });
    const out: SetEnvVarsOutput = { ...result };
    if (ctx) out.costSoFar = "$0";
    return out;
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}

export async function deployTool(
  args: DeployInput,
  ctx?: CredentialContext,
): Promise<
  DeployOutput | ToolError | NeedsConnectResult | NeedsConfirmationResult
> {
  if (args.provider !== "vercel" && args.provider !== "digitalocean") {
    return { error: `Unknown provider "${args.provider}". Use "vercel" or "digitalocean".` };
  }
  if (ctx) {
    const gate = await ctxGate({
      ctx,
      provider: args.provider,
      tool: "deploy",
      resourceName: args.projectName,
      args: args as unknown as Record<string, unknown>,
    });
    if (gate) return gate;
  }

  const adapter = await resolveAdapter(args.provider, ctx);
  if (isNeedsConnect(adapter)) return adapter;
  if (isToolError(adapter)) return adapter;

  // Provider-specific deploy source: Vercel uploads local files, DigitalOcean
  // references a registry image. Validate the right one is present.
  if (args.provider === "vercel" && (!args.files || args.files.length === 0)) {
    return {
      error:
        "Vercel deploys need files: pass the local files to upload as `files: [{ path, content }]`.",
    };
  }
  if (args.provider === "digitalocean" && (!args.image || args.image.trim() === "")) {
    return {
      error:
        'DigitalOcean deploys need a container image: pass `image` (e.g. "registry.digitalocean.com/myreg/web:1.2.3").',
    };
  }

  try {
    const result = await adapter.deploy({
      targetId: args.targetId,
      projectName: args.projectName,
      framework: args.framework,
      files: args.files,
      image: args.image,
      target: args.target,
    });
    const out: DeployOutput = {
      deploymentId: result.deploymentId,
      url: result.url,
      status: result.status,
    };
    if (ctx) {
      out.costSoFar = "$0";
      out.host = deploySuccessHost({ resourceName: args.projectName, url: result.url });
    }
    return out;
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}

export async function getDeployLogs(
  args: GetDeployLogsInput,
  ctx?: CredentialContext,
): Promise<GetDeployLogsOutput | ToolError | NeedsConnectResult> {
  // get_deploy_logs is READ-ONLY: it does NOT gate on a confirmToken. It still
  // surfaces needsConnect (ctx path) when there's no usable connection.
  if (ctx) {
    if (args.provider === "vercel" || args.provider === "digitalocean") {
      const connections = await readConnections(ctx);
      const connect = needsConnectFor(connections, asProviderName(args.provider));
      if (connect) return connect;
    }
  }
  const adapter = await resolveAdapter(args.provider, ctx);
  if (isNeedsConnect(adapter)) return adapter;
  if (isToolError(adapter)) return adapter;
  try {
    const result = await adapter.getLogs({
      deploymentId: args.deploymentId,
      type: args.type,
    });
    return {
      status: result.status,
      logText: result.logText,
      summary: result.summary,
    };
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}
