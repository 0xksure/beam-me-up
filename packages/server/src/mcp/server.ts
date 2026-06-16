/**
 * createServer - builds the Beam Me Up McpServer, registering the one prompt
 * and the tools, wiring each to its function.
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
  buildImagePlanInputShape,
  buildImagePlanOutputShape,
  checkCredentialsInputShape,
  checkCredentialsOutputShape,
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
} from "@beam-me-up/core";
import { renderBeamMeUpPlan } from "@beam-me-up/tools";
import { checkCredentials } from "@beam-me-up/tools";
import { buildImagePlan } from "@beam-me-up/tools";
import { routeTarget } from "@beam-me-up/detect";
import { validateCompose } from "@beam-me-up/tools";
import { writeTodo } from "@beam-me-up/tools";
import { preflightScan } from "@beam-me-up/detect";
import {
  createDeployTarget,
  setEnvVarsTool,
  deployTool,
  getDeployLogs,
} from "@beam-me-up/tools";
import { provisionDatabaseTool } from "@beam-me-up/tools";

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

  /* ---- tool: check_credentials ---------------------------------- */
  server.registerTool(
    "check_credentials",
    {
      title: "Check provider credentials",
      description:
        "Report which provider credentials are present in the server's " +
        "environment (vercel / digitalocean / neon / upstash) as booleans, so " +
        "you can route around missing providers BEFORE building images or " +
        "provisioning. Call this early. Values are never read out or echoed.",
      inputSchema: checkCredentialsInputShape,
      outputSchema: checkCredentialsOutputShape,
    },
    () => {
      const result = checkCredentials();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  /* ---- tool: build_image_plan ----------------------------------- */
  server.registerTool(
    "build_image_plan",
    {
      title: "Build/push image recipe",
      description:
        "Pure: emit the exact ordered commands to build + push a container " +
        "image (login, `docker buildx build --platform linux/amd64 … --push`), " +
        "the prerequisites to check (docker daemon, buildx, registry auth), and " +
        "the footgun warnings — chiefly that App Platform needs linux/amd64. " +
        "Call this before the host-owned build step; it does not run anything.",
      inputSchema: buildImagePlanInputShape,
      outputSchema: buildImagePlanOutputShape,
    },
    (args) => {
      const result = buildImagePlan(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
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
        "Create (or look up) the deploy target for this app and return its " +
        "targetId and dashboard URL. provider \"vercel\" creates a Vercel " +
        "project (needs VERCEL_TOKEN); provider \"digitalocean\" creates a " +
        "DigitalOcean App Platform app (needs DIGITALOCEAN_TOKEN).",
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
        "secrets, ALLOWED_EMAILS/ALLOWED_DOMAIN) onto the deploy target (a " +
        "Vercel project or a DigitalOcean app). Returns how many were set. " +
        "Secret values are never echoed back.",
      inputSchema: setEnvVarsInputShape,
      outputSchema: setEnvVarsOutputShape,
    },
    async (args) => deployToolResult(await setEnvVarsTool(args)),
  );

  /* ---- tool: deploy (M1) ---------------------------------------- */
  server.registerTool(
    "deploy",
    {
      title: "Deploy",
      description:
        "Create a deployment. provider \"vercel\": upload the given `files` " +
        "(two-phase SHA upload). provider \"digitalocean\": deploy the given " +
        "container `image` to the App Platform app. Returns the deploymentId, " +
        "the live URL, and the initial deploy status.",
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
        "Read build (or runtime) logs for a deployment (Vercel or DigitalOcean) " +
        "so you can diagnose a failed build. Returns the current status, the " +
        "joined log text, and a summary of the last error when the deploy failed.",
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
