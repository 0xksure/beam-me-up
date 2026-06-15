/**
 * createServer - builds the Beam Me Up McpServer, registering the one prompt
 * and three pure tools, wiring each to its pure function.
 *
 * SDK: @modelcontextprotocol/sdk (verified against v1.29.0).
 *   - server.registerTool(name, { title, description, inputSchema, outputSchema }, cb)
 *     where inputSchema/outputSchema are ZodRawShapes (plain objects of zod
 *     validators) and cb returns { content, structuredContent }.
 *   - server.registerPrompt(name, { title, description, argsSchema }, cb)
 *     where argsSchema is a ZodRawShape and cb returns { messages }.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  beamMeUpPromptArgsShape,
  routeTargetInputShape,
  routeTargetOutputShape,
  validateComposeInputShape,
  validateComposeOutputShape,
  writeTodoInputShape,
  writeTodoOutputShape,
  preflightScanInputShape,
  preflightScanOutputShape,
  createDeployTargetInputShape,
  createDeployTargetOutputShape,
  setEnvVarsInputShape,
  setEnvVarsOutputShape,
  deployInputShape,
  deployOutputShape,
  getDeployLogsInputShape,
  getDeployLogsOutputShape,
  provisionDatabaseInputShape,
  provisionDatabaseOutputShape,
} from "../schemas.js";
import { renderBeamMeUpPlan } from "../plan/beam-me-up-plan.js";
import { routeTarget } from "../tools/route-target.js";
import { validateCompose } from "../tools/validate-compose.js";
import { writeTodo } from "../tools/write-todo.js";
import { preflightScan } from "../tools/preflight-scan.js";
import {
  createDeployTarget,
  setEnvVarsTool,
  deployTool,
  getDeployLogs,
} from "../tools/deploy-tools.js";
import { provisionDatabaseTool } from "../tools/db-tools.js";

/**
 * A deploy-tool result is either its structured output or a { error } envelope.
 * isToolError narrows the union so the MCP wrapper can emit an isError result.
 */
function isToolError(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

/**
 * Standard MCP tool result for a deploy tool. A returned { error } becomes an
 * isError result whose text is the message; otherwise the structured output is
 * echoed both as JSON text content and as structuredContent.
 */
function deployToolResult(value: { error: string } | Record<string, unknown>) {
  if (isToolError(value)) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: value.error }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "beam-me-up",
    version: "0.0.0",
  });

  /* ---- prompt: beam_me_up ---------------------------------------- */
  server.registerPrompt(
    "beam_me_up",
    {
      title: "Beam Me Up",
      description:
        "Returns the ordered orchestration plan the host AI follows to take a " +
        "repo from inventory to a live deploy. M0 marks which steps are live " +
        "(route_target, validate_compose, write_todo) vs coming soon.",
      argsSchema: beamMeUpPromptArgsShape,
    },
    (args) => {
      const text = renderBeamMeUpPlan({ goal: args.goal, mode: args.mode });
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text },
          },
        ],
      };
    },
  );

  /* ---- tool: route_target --------------------------------------- */
  server.registerTool(
    "route_target",
    {
      title: "Route deploy target",
      description:
        "Pure decision logic: recommend Vercel (serverless) vs a container " +
        "host (DigitalOcean) based on RepoSignals. Returns target, " +
        "recommendedProvider, confidence and human-readable reasons.",
      inputSchema: routeTargetInputShape,
      outputSchema: routeTargetOutputShape,
    },
    (args) => {
      const result = routeTarget(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  /* ---- tool: validate_compose ----------------------------------- */
  server.registerTool(
    "validate_compose",
    {
      title: "Validate / generate docker-compose",
      description:
        "If composeYaml is provided, parse and structurally validate it. " +
        "Otherwise generate a docker-compose from detectedServices. Returns " +
        "the (possibly generated) composeYaml plus valid/errors/warnings.",
      inputSchema: validateComposeInputShape,
      outputSchema: validateComposeOutputShape,
    },
    (args) => {
      const result = validateCompose(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  /* ---- tool: write_todo ----------------------------------------- */
  server.registerTool(
    "write_todo",
    {
      title: "Write deploy TODO + ship checklist",
      description:
        "Produce TODO.md (manual setup, security follow-ups, ship checklist, " +
        "operate) and a structured ship checklist for the deploy outcome.",
      inputSchema: writeTodoInputShape,
      outputSchema: writeTodoOutputShape,
    },
    (args) => {
      const result = writeTodo(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  /* ---- tool: preflight_scan (M3) -------------------------------- */
  server.registerTool(
    "preflight_scan",
    {
      title: "Preflight: security + functionality review",
      description:
        "Pure repo analysis (no filesystem/network): the host AI passes the " +
        "files it read; returns repo signals, the detected stack " +
        "(frontend/backend/databases) + services, hardcoded-secret findings " +
        "(values masked) with a .env migration plan, access-control findings, " +
        "and a detected install/build/test/start plan with ordered " +
        "instructions. Feed signals/services into route_target and " +
        "securityFollowups into write_todo. Secret FINDINGS are masked; only " +
        "the returned .env migration content carries real values (for the " +
        "gitignored .env you write locally).",
      inputSchema: preflightScanInputShape,
      outputSchema: preflightScanOutputShape,
    },
    (args) => {
      const result = preflightScan(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  /* ---- tool: create_deploy_target (M1) -------------------------- */
  server.registerTool(
    "create_deploy_target",
    {
      title: "Create a deploy target",
      description:
        "Create the Vercel project for this app and return its targetId and " +
        "dashboard URL. Requires VERCEL_TOKEN in the environment. " +
        "provider must be \"vercel\" in M1 (DigitalOcean lands in M4).",
      inputSchema: createDeployTargetInputShape,
      outputSchema: createDeployTargetOutputShape,
    },
    async (args) => deployToolResult(await createDeployTarget(args)),
  );

  /* ---- tool: set_env_vars (M1) ---------------------------------- */
  server.registerTool(
    "set_env_vars",
    {
      title: "Set environment variables",
      description:
        "Upsert environment variables (DB URL, OAuth client id/secret, app " +
        "secrets, ALLOWED_EMAILS/ALLOWED_DOMAIN) onto a Vercel project. " +
        "Returns how many were set. Secret values are never echoed back.",
      inputSchema: setEnvVarsInputShape,
      outputSchema: setEnvVarsOutputShape,
    },
    async (args) => deployToolResult(await setEnvVarsTool(args)),
  );

  /* ---- tool: deploy (M1) ---------------------------------------- */
  server.registerTool(
    "deploy",
    {
      title: "Deploy local files",
      description:
        "Upload the given local files and create a Vercel deployment " +
        "(two-phase SHA upload). Returns the deploymentId, the live URL, and " +
        "the initial deploy status.",
      inputSchema: deployInputShape,
      outputSchema: deployOutputShape,
    },
    async (args) => deployToolResult(await deployTool(args)),
  );

  /* ---- tool: get_deploy_logs (M1) ------------------------------- */
  server.registerTool(
    "get_deploy_logs",
    {
      title: "Read deploy logs",
      description:
        "Read build (or runtime) logs for a Vercel deployment so you can " +
        "diagnose a failed build. Returns the current status, the joined log " +
        "text, and a summary of the last error when the deploy failed.",
      inputSchema: getDeployLogsInputShape,
      outputSchema: getDeployLogsOutputShape,
    },
    async (args) => deployToolResult(await getDeployLogs(args)),
  );

  /* ---- tool: provision_database (M2) ---------------------------- */
  server.registerTool(
    "provision_database",
    {
      title: "Provision a managed database",
      description:
        "Headlessly create a managed database and return its connection-string " +
        "env vars. engine \"postgres\" provisions Neon (needs NEON_API_KEY); " +
        "engine \"redis\" provisions Upstash (needs UPSTASH_EMAIL + " +
        "UPSTASH_API_KEY). Returns { provider, resourceId, envVars } - feed " +
        "envVars into set_env_vars. Credentials are never echoed back.",
      inputSchema: provisionDatabaseInputShape,
      outputSchema: provisionDatabaseOutputShape,
    },
    async (args) => deployToolResult(await provisionDatabaseTool(args)),
  );

  return server;
}
