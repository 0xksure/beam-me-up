/**
 * The four M1 deploy tool handler functions.
 *
 * Each tool:
 *   - takes the already-validated args object (parsed against the schema in
 *     server.ts),
 *   - resolves the provider token internally via getProviderToken,
 *   - picks the adapter via selectAdapter,
 *   - delegates to the matching DeployTarget method,
 *   - and NEVER throws uncaught: on a missing token, a non-vercel provider, or a
 *     provider error it returns a structured { error: string } which the MCP
 *     handler in server.ts turns into an isError result.
 *
 * Contract:
 *   - provider !== "vercel"  -> { error: "DigitalOcean lands in M4 — use
 *       provider: vercel for now." }
 *   - getProviderToken(provider) === null -> { error: <tell the user to set
 *       VERCEL_TOKEN> }
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
} from "../schemas.js";
import type { DeployTarget } from "../adapters/deploy/interface.js";
import { selectAdapter } from "../adapters/registry.js";
import { getProviderToken } from "../auth/token.js";

/** Message for any non-vercel provider in M1. */
const M4_MESSAGE =
  "DigitalOcean lands in M4 — use provider: vercel for now.";

/** Message when no Vercel credential is configured. */
const MISSING_TOKEN_MESSAGE =
  "No Vercel token found. Set the VERCEL_TOKEN environment variable (and optionally VERCEL_TEAM_ID) to deploy to Vercel.";

/**
 * Resolve the adapter for a tool call, or return a { error } envelope.
 *
 * Handles the two pre-flight failure modes the contract calls out:
 *   - a non-vercel provider (M4), and
 *   - a missing token (set VERCEL_TOKEN).
 *
 * The `provider` field is statically narrowed to "vercel" by the zod enum, but
 * we still compare at runtime so a value that slips past validation (or a
 * future widened schema) is rejected with the friendly M4 message instead of
 * reaching the Vercel REST API.
 */
function resolveAdapter(provider: string): DeployTarget | ToolError {
  if (provider !== "vercel") {
    return { error: M4_MESSAGE };
  }
  const token = getProviderToken("vercel");
  if (token === null) {
    return { error: MISSING_TOKEN_MESSAGE };
  }
  return selectAdapter("vercel", token);
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
  try {
    const result = await adapter.deploy({
      targetId: args.targetId,
      projectName: args.projectName,
      framework: args.framework,
      files: args.files,
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
