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
 *     provider error it returns a structured { error: string } which the MCP
 *     handler in server.ts turns into an isError result.
 *
 * Contract:
 *   - provider not "vercel"/"digitalocean" -> { error: 'Unknown provider ...' }
 *   - getProviderToken(provider) === null -> { error: <set VERCEL_TOKEN or
 *       DIGITALOCEAN_TOKEN> }
 *   - deploy: provider "vercel" needs `files`; provider "digitalocean" needs an
 *       `image` reference. The missing one returns a clear { error }.
 *   - any provider/runtime error is caught and returned as { error }.
 *   - secrets / tokens are never logged.
 */
import type {
  CreateDeployTargetInput,
  CreateDeployTargetOutput,
  DeployInput,
  DeployOutput,
  GetDeployLogsInput,
  GetDeployLogsOutput,
  SetEnvVarsInput,
  SetEnvVarsOutput,
  ToolError,
} from "@beam-me-up/core";
import type { DeployTarget } from "@beam-me-up/adapters";
import { selectAdapter } from "@beam-me-up/adapters";
import { getProviderToken } from "@beam-me-up/adapters";

/** Friendly "set your token" message per provider. */
function missingTokenMessage(provider: "vercel" | "digitalocean"): string {
  return provider === "vercel"
    ? "No Vercel token found. Set the VERCEL_TOKEN environment variable (and optionally VERCEL_TEAM_ID) to deploy to Vercel."
    : "No DigitalOcean token found. Set the DIGITALOCEAN_TOKEN environment variable to deploy to DigitalOcean App Platform.";
}

/**
 * Resolve the adapter for a tool call, or return a { error } envelope.
 *
 * Handles the two pre-flight failure modes the contract calls out:
 *   - an unknown provider, and
 *   - a missing token (set VERCEL_TOKEN / DIGITALOCEAN_TOKEN).
 *
 * `provider` is narrowed to "vercel" | "digitalocean" by the zod enum, but we
 * still compare at runtime so a value that slips past validation is rejected
 * before it ever reaches a provider REST API.
 */
function resolveAdapter(provider: string): DeployTarget | ToolError {
  if (provider !== "vercel" && provider !== "digitalocean") {
    return {
      error: `Unknown provider "${provider}". Use "vercel" or "digitalocean".`,
    };
  }
  const token = getProviderToken(provider);
  if (token === null) {
    return { error: missingTokenMessage(provider) };
  }
  return selectAdapter(provider, token);
}

/** Narrow the resolveAdapter result. */
function isToolError(value: DeployTarget | ToolError): value is ToolError {
  return (value as ToolError).error !== undefined;
}

/** Coerce any thrown value into a human-readable error string. */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error while talking to the deploy provider.";
}

export async function createDeployTarget(
  args: CreateDeployTargetInput,
): Promise<CreateDeployTargetOutput | ToolError> {
  const adapter = resolveAdapter(args.provider);
  if (isToolError(adapter)) return adapter;
  try {
    const { targetId, dashboardUrl } = await adapter.createProject({
      name: args.projectName,
      framework: args.framework,
    });
    return { provider: adapter.id, targetId, dashboardUrl };
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}

export async function setEnvVarsTool(
  args: SetEnvVarsInput,
): Promise<SetEnvVarsOutput | ToolError> {
  const adapter = resolveAdapter(args.provider);
  if (isToolError(adapter)) return adapter;
  try {
    return await adapter.setEnvVars({
      targetId: args.targetId,
      vars: args.vars,
    });
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}

export async function deployTool(
  args: DeployInput,
): Promise<DeployOutput | ToolError> {
  const adapter = resolveAdapter(args.provider);
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
    return {
      deploymentId: result.deploymentId,
      url: result.url,
      status: result.status,
    };
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}

export async function getDeployLogs(
  args: GetDeployLogsInput,
): Promise<GetDeployLogsOutput | ToolError> {
  const adapter = resolveAdapter(args.provider);
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
