/**
 * Beam Me Up - shared schemas and domain types.
 *
 * For every tool's I/O we export THREE things:
 *   1. a zod RAW SHAPE (plain object of zod validators) - used to register the
 *      MCP tool's inputSchema/outputSchema (the SDK wants a ZodRawShape, not a
 *      z.object(...)).
 *   2. a z.object(shape) - used when we want to parse/validate at runtime.
 *   3. an inferred TypeScript type via z.infer - the contract type used across
 *      the pure functions.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Shared domain types                                                 */
/* ------------------------------------------------------------------ */

export type RepoSignals = {
  hasDockerfile: boolean;
  composeAppServices: number;
  wsServer: boolean;
  workers: boolean;
  listensOnPort: boolean;
  longHandlers: boolean;
  persistentFsWrites: boolean;
  framework?: string;
};

export type DetectedService = {
  name: string;
  kind: "app" | "postgres" | "redis" | "mysql" | "mongo" | "other";
  image?: string;
  port?: number;
  envFile?: string;
};

export type DeployTargetId = "vercel" | "digitalocean";

export type ChecklistItem = {
  id: string;
  label: string;
  done: boolean;
  blocking: boolean;
};

/* ------------------------------------------------------------------ */
/* Zod building blocks for the domain types                           */
/* ------------------------------------------------------------------ */

export const repoSignalsShape = {
  hasDockerfile: z.boolean(),
  composeAppServices: z.number().int().nonnegative(),
  wsServer: z.boolean(),
  workers: z.boolean(),
  listensOnPort: z.boolean(),
  longHandlers: z.boolean(),
  persistentFsWrites: z.boolean(),
  framework: z.string().optional(),
} as const;
export const RepoSignalsSchema = z.object(repoSignalsShape);

export const detectedServiceShape = {
  name: z.string(),
  kind: z.enum(["app", "postgres", "redis", "mysql", "mongo", "other"]),
  image: z.string().optional(),
  port: z.number().int().optional(),
  envFile: z.string().optional(),
} as const;
export const DetectedServiceSchema = z.object(detectedServiceShape);

export const DeployTargetIdSchema = z.enum(["vercel", "digitalocean"]);

export const checklistItemShape = {
  id: z.string(),
  label: z.string(),
  done: z.boolean(),
  blocking: z.boolean(),
} as const;
export const ChecklistItemSchema = z.object(checklistItemShape);

/* ------------------------------------------------------------------ */
/* route_target                                                        */
/* ------------------------------------------------------------------ */

export const routeTargetInputShape = {
  stack: z.string().optional(),
  services: z.array(DetectedServiceSchema).optional(),
  signals: RepoSignalsSchema,
} as const;
export const RouteTargetInputSchema = z.object(routeTargetInputShape);
export type RouteTargetInput = z.infer<typeof RouteTargetInputSchema>;

export const routeTargetOutputShape = {
  target: z.enum(["vercel", "container"]),
  recommendedProvider: z.enum(["vercel", "digitalocean"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
} as const;
export const RouteTargetOutputSchema = z.object(routeTargetOutputShape);
export type RouteTargetOutput = z.infer<typeof RouteTargetOutputSchema>;

/* ------------------------------------------------------------------ */
/* validate_compose                                                    */
/* ------------------------------------------------------------------ */

export const validateComposeInputShape = {
  composeYaml: z.string().optional(),
  detectedServices: z.array(DetectedServiceSchema).optional(),
} as const;
export const ValidateComposeInputSchema = z.object(validateComposeInputShape);
export type ValidateComposeInput = z.infer<typeof ValidateComposeInputSchema>;

export const validateComposeOutputShape = {
  composeYaml: z.string(),
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
} as const;
export const ValidateComposeOutputSchema = z.object(validateComposeOutputShape);
export type ValidateComposeOutput = z.infer<typeof ValidateComposeOutputSchema>;

/* ------------------------------------------------------------------ */
/* write_todo                                                          */
/* ------------------------------------------------------------------ */

export const writeTodoInputShape = {
  stack: z.string().optional(),
  target: DeployTargetIdSchema,
  authNeeded: z.boolean(),
  mode: z.enum(["product", "internal"]).optional(),
  /** Detected database engines (e.g. ["postgres"]) so the checklist + operate
   *  guidance can tailor DB-specific items (connection string, TLS, firewall). */
  databases: z.array(z.string()).optional(),
  manualItems: z.array(z.string()).optional(),
  securityFollowups: z.array(z.string()).optional(),
  liveUrl: z.string().optional(),
} as const;
export const WriteTodoInputSchema = z.object(writeTodoInputShape);
export type WriteTodoInput = z.infer<typeof WriteTodoInputSchema>;

export const writeTodoOutputShape = {
  todoMarkdown: z.string(),
  shipChecklist: z.array(ChecklistItemSchema),
} as const;
export const WriteTodoOutputSchema = z.object(writeTodoOutputShape);
export type WriteTodoOutput = z.infer<typeof WriteTodoOutputSchema>;

/* ================================================================== */
/* M9 P3a — the shared tool-output result envelope                     */
/* ================================================================== */

/*
 * Beam is an MCP server: it returns *tool results*, not UI. Every UX moment is
 * a structured tool result the host AI renders. The envelope below is the
 * single shared contract for every NON-`ok` credentialed-tool result.
 *
 *   status        — the discriminator the host branches on.
 *   host          — server-owned plain-language copy (`speak`) + `buttons`. The
 *                   host renders `host.speak` verbatim and each button as a tap
 *                   target; it NEVER invents next steps and NEVER shows a raw
 *                   `error` string. (See the host-rendering rule in
 *                   beam-me-up-plan.ts.)
 *
 * `isError` is set on the MCP result ONLY for `status: "error"` — the server
 * wrapper keys off `status`. needsConnect / needsConfirmation are normal (not
 * error) results that simply carry a next step.
 *
 * These shapes are emitted only on the per-user (`ctx` present) path. The
 * no-`ctx` self-host/stdio path keeps the existing env-var messages verbatim —
 * that audience wants `Set the VERCEL_TOKEN…`.
 */

/** Provider display names — fixed by the spec, never abbreviations. */
export const ProviderNameSchema = z.enum([
  "github",
  "vercel",
  "digitalocean",
  "neon",
  "upstash",
]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

/** What a destination/connection is FOR, in Sam's terms. */
export const ConnectionRoleSchema = z.enum(["code", "hosting", "database"]);
export type ConnectionRole = z.infer<typeof ConnectionRoleSchema>;

export const resultStatusShape = z.enum([
  "ok",
  "needsConnect",
  "needsConfirmation",
  "error",
]);
export type ResultStatus = z.infer<typeof resultStatusShape>;

/** A running connect/recovery tally the host renders as "N of 3". */
export const progressShape = {
  connected: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  nextRole: z.string().optional(),
  label: z.string().optional(),
} as const;
export const ProgressSchema = z.object(progressShape);
export type Progress = z.infer<typeof ProgressSchema>;

/**
 * A button action. `callTool` re-invokes a Beam tool (e.g. the confirm path
 * re-calls the same tool WITH the confirmToken); `openUrl` opens a Connect /
 * connections page; `cancel` abandons with no tool call.
 */
export const HostButtonActionSchema = z.union([
  z.object({
    kind: z.literal("callTool"),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("openUrl"), url: z.string() }),
  z.object({ kind: z.literal("cancel") }),
]);
export type HostButtonAction = z.infer<typeof HostButtonActionSchema>;

export const HostButtonSchema = z.object({
  label: z.string(),
  action: HostButtonActionSchema,
});
export type HostButton = z.infer<typeof HostButtonSchema>;

/** The server-owned host directive carried on every non-`ok` result. */
export const HostDirectiveSchema = z.object({
  speak: z.string(),
  buttons: z.array(HostButtonSchema),
  progress: ProgressSchema.optional(),
});
export type HostDirective = z.infer<typeof HostDirectiveSchema>;

/* ---- needsConfirmation (the destination gate, §1) ---------------- */

export const DestinationLabelSchema = z.object({
  provider: ProviderNameSchema,
  role: ConnectionRoleSchema,
  /** Non-secret display label from the vault connection (providerAccountId). */
  accountLabel: z.string(),
  teamLabel: z.string().optional(),
  freeTier: z.boolean().optional(),
});
export type DestinationLabel = z.infer<typeof DestinationLabelSchema>;

export const NeedsConfirmationResultSchema = z.object({
  status: z.literal("needsConfirmation"),
  tool: z.string(),
  actionSummary: z.string(),
  destinations: z.array(DestinationLabelSchema),
  resourceName: z.string(),
  confirmToken: z.string(),
  confirmTokenExpiresAt: z.string(),
  costSoFar: z.literal("$0"),
  host: HostDirectiveSchema,
});
export type NeedsConfirmationResult = z.infer<
  typeof NeedsConfirmationResultSchema
>;

/* ---- needsConnect (the mid-chat Connect round-trip, §2) ---------- */

export const NeedsConnectReasonSchema = z.enum([
  "no_connection",
  "expired",
  "revoked",
]);
export type NeedsConnectReason = z.infer<typeof NeedsConnectReasonSchema>;

export const NeedsConnectResultSchema = z.object({
  status: z.literal("needsConnect"),
  provider: ProviderNameSchema,
  role: ConnectionRoleSchema,
  connectUrl: z.string(),
  reason: NeedsConnectReasonSchema,
  progress: ProgressSchema.optional(),
  safety: z.object({
    free: z.literal(true),
    canSpendMoney: z.literal(false),
    disconnectable: z.literal(true),
  }),
  resumeHint: z.literal("autoProbe"),
  host: HostDirectiveSchema,
});
export type NeedsConnectResult = z.infer<typeof NeedsConnectResultSchema>;

/* ---- the error-recovery copy deck (§3) --------------------------- */

export const RecoveryKindSchema = z.enum([
  "connect",
  "reconnect_expired",
  "reconnect_failed",
  "reconnect_revoked",
  "wrong_account",
  "connect_abandoned",
  "db_needs_managed",
]);
export type RecoveryKind = z.infer<typeof RecoveryKindSchema>;

/** The `database` synthetic provider covers the role-level DB copy. */
export const RecoveryProviderSchema = z.enum([
  "github",
  "vercel",
  "digitalocean",
  "neon",
  "upstash",
  "database",
]);
export type RecoveryProvider = z.infer<typeof RecoveryProviderSchema>;

export const RecoverySchema = z.object({
  kind: RecoveryKindSchema,
  provider: RecoveryProviderSchema,
  /** Stable machine code (host bookkeeping only — NEVER shown to the user). */
  errorCode: z.string(),
  headline: z.string(),
  reassurance: z.string(),
  primaryAction: z.object({ label: z.string(), action: HostButtonActionSchema }),
  secondaryAction: z
    .object({ label: z.string(), action: HostButtonActionSchema })
    .optional(),
  progress: ProgressSchema.optional(),
});
export type Recovery = z.infer<typeof RecoverySchema>;

/** An `error`-status envelope: a genuine failure with plain-language copy. */
export const ErrorResultSchema = z.object({
  status: z.literal("error"),
  /** Stable machine code — host bookkeeping only, never shown. */
  errorCode: z.string().optional(),
  /** Structured recovery block, when this error has a recovery path. */
  recovery: RecoverySchema.optional(),
  host: HostDirectiveSchema,
});
export type ErrorResult = z.infer<typeof ErrorResultSchema>;

/**
 * The full union a credentialed tool can return on the ctx path. `ok` results
 * are the tools' own success outputs (now additively carrying `costSoFar` +
 * `host`); the three non-`ok` envelopes carry their own `status`.
 */
export type CredentialedToolEnvelope =
  | NeedsConnectResult
  | NeedsConfirmationResult
  | ErrorResult;

/** Narrow any value to one of the non-`ok` envelopes (host bookkeeping). */
export function isNonOkEnvelope(
  value: unknown,
): value is CredentialedToolEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    ((value as { status?: unknown }).status === "needsConnect" ||
      (value as { status?: unknown }).status === "needsConfirmation" ||
      (value as { status?: unknown }).status === "error")
  );
}

/* ---- the Sam-facing connections view (§4.2) ---------------------- */

export const ConnectionViewStatusSchema = z.enum([
  "connected",
  "expired",
  "revoked",
  "not_connected",
]);
export type ConnectionViewStatus = z.infer<typeof ConnectionViewStatusSchema>;

export const ConnectionSchema = z.object({
  provider: ProviderNameSchema,
  displayName: z.string(),
  status: ConnectionViewStatusSchema,
  accountLabel: z.string().optional(),
  teamLabel: z.string().optional(),
  statusLine: z.string(),
  actions: z.array(
    z.object({
      kind: z.enum(["switch", "disconnect", "connect", "reconnect"]),
      label: z.string(),
      href: z.string(),
    }),
  ),
  manageUrl: z.string(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const listConnectionsOutputShape = {
  connections: z.array(ConnectionSchema),
  headline: z.string(),
  manageUrl: z.string(),
  host: HostDirectiveSchema,
} as const;
export const ListConnectionsOutputSchema = z.object(listConnectionsOutputShape);
export type ListConnectionsOutput = z.infer<typeof ListConnectionsOutputSchema>;

export const listConnectionsInputShape = {} as const;
export const ListConnectionsInputSchema = z.object(listConnectionsInputShape);
export type ListConnectionsInput = z.infer<typeof ListConnectionsInputSchema>;

/* ------------------------------------------------------------------ */
/* check_credentials (capability check)                                */
/* ------------------------------------------------------------------ */

/**
 * check_credentials reports which provider credentials are present in the
 * SERVER's environment, so the host AI can route around missing providers
 * BEFORE doing expensive work (building images, provisioning). It reports
 * booleans only — credential values are never read out or echoed.
 */
export const checkCredentialsInputShape = {} as const;
export const CheckCredentialsInputSchema = z.object(checkCredentialsInputShape);
export type CheckCredentialsInput = z.infer<typeof CheckCredentialsInputSchema>;

export const checkCredentialsConnectionShape = {
  provider: ProviderNameSchema,
  role: ConnectionRoleSchema,
  connected: z.boolean(),
  /** Present when connected (non-secret, from the vault). */
  accountLabel: z.string().optional(),
  /** Present when NOT connected — the /connect/<provider> URL. */
  connectUrl: z.string().optional(),
  status: z.enum(["active", "expired", "revoked"]).optional(),
} as const;
export const CheckCredentialsConnectionSchema = z.object(
  checkCredentialsConnectionShape,
);
export type CheckCredentialsConnection = z.infer<
  typeof CheckCredentialsConnectionSchema
>;

export const checkCredentialsOutputShape = {
  /**
   * Per-user connection rollup (ctx path). Each row means "does THIS user have
   * an active connection". On the no-ctx self-host path this mirrors env
   * presence.
   */
  connections: z.array(CheckCredentialsConnectionSchema),
  /** Running tally for the host's progress checklist. */
  progress: ProgressSchema,
  /** Vercel deploys. */
  vercel: z.boolean(),
  /** DigitalOcean deploys. */
  digitalocean: z.boolean(),
  /** Postgres provisioning via Neon. */
  neon: z.boolean(),
  /** Redis provisioning via Upstash. */
  upstash: z.boolean(),
  /** Capability names that ARE configured (a convenience for the planner). */
  configured: z.array(z.string()),
  /**
   * Capability names that are NOT configured. On the ctx path this reads
   * "<name> (not connected)" — never "(set NEON_API_KEY)". On the no-ctx
   * self-host path the env-var hint is retained.
   */
  missing: z.array(z.string()),
  /** Host directive: e.g. "You've connected 2 of 3." (ctx path). */
  host: HostDirectiveSchema.optional(),
} as const;
export const CheckCredentialsOutputSchema = z.object(
  checkCredentialsOutputShape,
);
export type CheckCredentialsOutput = z.infer<
  typeof CheckCredentialsOutputSchema
>;

/* ------------------------------------------------------------------ */
/* build_image_plan (guard the host-owned docker build/push)           */
/* ------------------------------------------------------------------ */

/**
 * build_image_plan is a PURE tool that emits the exact, ordered commands the
 * host AI should run to build + push a container image, plus the prerequisites
 * to check and the footguns to avoid — chiefly the linux/amd64 one. It does NOT
 * run anything (the server has no shell); it turns the riskiest, most
 * environment-fragile seam in a DigitalOcean deploy into a checked recipe.
 */
export const buildImagePlanInputShape = {
  repository: z
    .string()
    .describe('The image repository / app name, e.g. "web".'),
  registry: z
    .string()
    .optional()
    .describe(
      "Registry name/owner: a DOCR registry name, a Docker Hub org, or a GHCR owner. Omit for DOCR to have the recipe discover it via `doctl registry get`.",
    ),
  registryType: z
    .enum(["docr", "dockerhub", "ghcr"])
    .optional()
    .describe('Defaults to "docr" (DigitalOcean Container Registry).'),
  tag: z
    .string()
    .optional()
    .describe('Image tag. Pin a real version or git SHA, not "latest".'),
  contextPath: z
    .string()
    .optional()
    .describe('Docker build context. Defaults to ".".'),
} as const;
export const BuildImagePlanInputSchema = z.object(buildImagePlanInputShape);
export type BuildImagePlanInput = z.infer<typeof BuildImagePlanInputSchema>;

export const buildImagePlanOutputShape = {
  /** The full image reference the host should build + push + then `deploy`. */
  imageRef: z.string(),
  /** Ordered shell commands to run (login, buildx build --push). */
  commands: z.array(z.string()),
  /** Things to verify first (docker daemon, buildx, registry auth). */
  prerequisites: z.array(z.string()),
  /** Footguns — chiefly the linux/amd64 cross-build requirement. */
  warnings: z.array(z.string()),
} as const;
export const BuildImagePlanOutputSchema = z.object(buildImagePlanOutputShape);
export type BuildImagePlanOutput = z.infer<typeof BuildImagePlanOutputSchema>;

/* ------------------------------------------------------------------ */
/* beam_me_up prompt                                                   */
/* ------------------------------------------------------------------ */

export const beamMeUpPromptArgsShape = {
  goal: z.string().optional(),
  mode: z.enum(["product", "internal"]).optional(),
} as const;
export const BeamMeUpPromptArgsSchema = z.object(beamMeUpPromptArgsShape);
export type BeamMeUpPromptArgs = z.infer<typeof BeamMeUpPromptArgsSchema>;

/* ================================================================== */
/* M1 - deploy adapter tools                                           */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Shared M1 building blocks: provider, EnvVar, DeployFile            */
/* ------------------------------------------------------------------ */

/**
 * The provider accepted by the deploy tools. M1 shipped Vercel; M4 adds
 * DigitalOcean (App Platform, container-image deploys). Vercel deploys upload
 * local `files`; DigitalOcean deploys reference a registry `image` — the deploy
 * handler validates the right one is present per provider.
 */
export const DeployProviderSchema = z.enum(["vercel", "digitalocean"]);
export type DeployProvider = z.infer<typeof DeployProviderSchema>;

export const envVarShape = {
  key: z.string(),
  value: z.string(),
  secret: z.boolean().optional(),
  targets: z.array(z.string()).optional(),
} as const;
export const EnvVarSchema = z.object(envVarShape);
export type EnvVarInput = z.infer<typeof EnvVarSchema>;

export const deployFileShape = {
  path: z.string(),
  content: z.string().optional(),
  contentBase64: z.string().optional(),
} as const;
export const DeployFileSchema = z.object(deployFileShape);
export type DeployFileInput = z.infer<typeof DeployFileSchema>;

/* ------------------------------------------------------------------ */
/* create_deploy_target                                                */
/* ------------------------------------------------------------------ */

export const createDeployTargetInputShape = {
  provider: DeployProviderSchema,
  projectName: z.string(),
  framework: z.string().optional(),
} as const;
export const CreateDeployTargetInputSchema = z.object(
  createDeployTargetInputShape,
);
export type CreateDeployTargetInput = z.infer<
  typeof CreateDeployTargetInputSchema
>;

export const createDeployTargetOutputShape = {
  provider: z.string(),
  targetId: z.string(),
  dashboardUrl: z.string(),
  /** M9 P3a: the standing money promise, surfaced on the ctx path. */
  costSoFar: z.literal("$0").optional(),
  /** M9 P3a: server-owned success copy for the host to render (ctx path). */
  host: HostDirectiveSchema.optional(),
} as const;
export const CreateDeployTargetOutputSchema = z.object(
  createDeployTargetOutputShape,
);
export type CreateDeployTargetOutput = z.infer<
  typeof CreateDeployTargetOutputSchema
>;

/* ------------------------------------------------------------------ */
/* set_env_vars                                                        */
/* ------------------------------------------------------------------ */

export const setEnvVarsInputShape = {
  provider: DeployProviderSchema,
  targetId: z.string(),
  vars: z.array(EnvVarSchema),
} as const;
export const SetEnvVarsInputSchema = z.object(setEnvVarsInputShape);
export type SetEnvVarsInput = z.infer<typeof SetEnvVarsInputSchema>;

export const setEnvVarsOutputShape = {
  setCount: z.number().int().nonnegative(),
  applied: z.array(z.string()),
  /** M9 P3a: the standing money promise, surfaced on the ctx path. */
  costSoFar: z.literal("$0").optional(),
  /** M9 P3a: server-owned success copy for the host to render (ctx path). */
  host: HostDirectiveSchema.optional(),
} as const;
export const SetEnvVarsOutputSchema = z.object(setEnvVarsOutputShape);
export type SetEnvVarsOutput = z.infer<typeof SetEnvVarsOutputSchema>;

/* ------------------------------------------------------------------ */
/* deploy                                                              */
/* ------------------------------------------------------------------ */

export const deployInputShape = {
  provider: DeployProviderSchema,
  targetId: z.string(),
  projectName: z.string(),
  framework: z.string().optional(),
  /** Vercel: the local files to upload + deploy. Required for provider "vercel". */
  files: z
    .array(DeployFileSchema)
    .optional()
    .describe(
      'REQUIRED when provider="vercel" (the local files to upload). Ignored for provider="digitalocean".',
    ),
  /**
   * DigitalOcean: a container image reference to deploy, e.g.
   * "registry.digitalocean.com/myreg/web:1.2.3", "docker.io/acme/web:1.2.3",
   * "ghcr.io/acme/web:1.2.3", or "acme/web:1.2.3" (Docker Hub). Required for
   * provider "digitalocean".
   */
  image: z
    .string()
    .optional()
    .describe(
      'REQUIRED when provider="digitalocean" (a container image ref, e.g. "registry.digitalocean.com/reg/web:1.2.3"). Ignored for provider="vercel".',
    ),
  target: z.enum(["production", "preview"]).optional(),
} as const;
export const DeployInputSchema = z.object(deployInputShape);
export type DeployInput = z.infer<typeof DeployInputSchema>;

export const deployOutputShape = {
  deploymentId: z.string(),
  url: z.string().optional(),
  status: z.string(),
  /** M9 P3a: the standing money promise, surfaced on the ctx path. */
  costSoFar: z.literal("$0").optional(),
  /** M9 P3a: server-owned success copy for the host to render (ctx path). */
  host: HostDirectiveSchema.optional(),
} as const;
export const DeployOutputSchema = z.object(deployOutputShape);
export type DeployOutput = z.infer<typeof DeployOutputSchema>;

/* ------------------------------------------------------------------ */
/* get_deploy_logs                                                     */
/* ------------------------------------------------------------------ */

export const getDeployLogsInputShape = {
  provider: DeployProviderSchema,
  deploymentId: z.string(),
  type: z.enum(["build", "runtime"]).optional(),
} as const;
export const GetDeployLogsInputSchema = z.object(getDeployLogsInputShape);
export type GetDeployLogsInput = z.infer<typeof GetDeployLogsInputSchema>;

export const getDeployLogsOutputShape = {
  status: z.string(),
  logText: z.string(),
  summary: z.string().optional(),
} as const;
export const GetDeployLogsOutputSchema = z.object(getDeployLogsOutputShape);
export type GetDeployLogsOutput = z.infer<typeof GetDeployLogsOutputSchema>;

/* ================================================================== */
/* M2 - database provisioning tool                                     */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* provision_database                                                  */
/* ------------------------------------------------------------------ */

/**
 * The database engine accepted by the M2 provision_database tool. postgres maps
 * to Neon, redis maps to Upstash. Other engines are rejected at the handler
 * with a friendly "M2 supports postgres (Neon) and redis (Upstash) only"
 * message.
 */
export const DbEngineSchema = z.enum(["postgres", "redis"]);
export type DbEngineInput = z.infer<typeof DbEngineSchema>;

export const provisionDatabaseInputShape = {
  engine: DbEngineSchema,
  name: z.string(),
  region: z.string().optional(),
} as const;
export const ProvisionDatabaseInputSchema = z.object(
  provisionDatabaseInputShape,
);
export type ProvisionDatabaseInput = z.infer<
  typeof ProvisionDatabaseInputSchema
>;

export const provisionDatabaseOutputShape = {
  provider: z.string(),
  resourceId: z.string(),
  envVars: z.record(z.string(), z.string()),
  /** M9 P3a: the standing money promise, surfaced on the ctx path. */
  costSoFar: z.literal("$0").optional(),
  /** M9 P3a: server-owned success copy for the host to render (ctx path). */
  host: HostDirectiveSchema.optional(),
} as const;
export const ProvisionDatabaseOutputSchema = z.object(
  provisionDatabaseOutputShape,
);
export type ProvisionDatabaseOutput = z.infer<
  typeof ProvisionDatabaseOutputSchema
>;

/* ------------------------------------------------------------------ */
/* Tool error envelope (handler turns { error } into an isError result)*/
/* ------------------------------------------------------------------ */

export type ToolError = { error: string };

/* ================================================================== */
/* M3 - preflight_scan (security + functionality review)               */
/* ================================================================== */

/*
 * preflight_scan is the "front door" analysis tool. The host AI reads the repo
 * with its own file tools and passes the files in; preflight_scan is PURE (no
 * filesystem, no network) and returns a structural + security read of the repo:
 *
 *   - signals : RepoSignals (via deriveSignals) so route_target can consume them
 *   - stack   : the detected frontend / backend / databases / languages + the
 *               Dockerfile/compose paths
 *   - services: DetectedService[] for validate_compose / route_target
 *   - secrets : hardcoded credentials found in source (value ALWAYS masked)
 *   - envPlan : the .env migration plan (what to write, gitignore, replace)
 *   - accessControl : heuristic access-control / security-posture findings
 *   - build   : detected install/build/test/start + ordered instructions
 *               (the "detect & instruct" functionality review)
 *   - securityFollowups : strings to feed straight into write_todo
 *   - instructions      : ordered next steps for the host AI
 *   - summary           : a short human-readable overview
 */

/* ------------------------------------------------------------------ */
/* preflight building blocks                                           */
/* ------------------------------------------------------------------ */

/** A repo file the host AI read and passed in: path + (string) content. */
export const preflightFileShape = {
  path: z.string(),
  content: z.string(),
} as const;
export const PreflightFileSchema = z.object(preflightFileShape);
export type PreflightFile = z.infer<typeof PreflightFileSchema>;

/**
 * A hardcoded secret/credential found in source. The matched value is ALWAYS
 * masked (e.g. "sk_live_…a1b2") — preflight_scan NEVER echoes a full secret in
 * its own output, even though it is a security tool reading secret-bearing code.
 */
export const secretFindingShape = {
  file: z.string(),
  line: z.number().int().nonnegative(),
  /** e.g. "aws-access-key-id" | "private-key" | "connection-string" |
   *  "generic-api-key" | "password-literal" | "jwt" | "slack-token". */
  kind: z.string(),
  /** Redacted preview of the matched value. Never the full secret. */
  masked: z.string(),
  /** Suggested env var name, e.g. "DATABASE_URL", "STRIPE_SECRET_KEY". */
  suggestedEnvKey: z.string(),
  severity: z.enum(["high", "medium", "low"]),
} as const;
export const SecretFindingSchema = z.object(secretFindingShape);
export type SecretFinding = z.infer<typeof SecretFindingSchema>;

/** One inline secret the host AI should replace with an env reference. */
export const envReplacementShape = {
  file: z.string(),
  line: z.number().int().nonnegative(),
  envKey: z.string(),
  note: z.string(),
} as const;
export const EnvReplacementSchema = z.object(envReplacementShape);
export type EnvReplacement = z.infer<typeof EnvReplacementSchema>;

/** The .env migration plan: what to write, what to gitignore, what to replace. */
export const envPlanShape = {
  /** `KEY=value` lines (values = the found secrets) so the app keeps working locally. */
  envFileContent: z.string(),
  /** `KEY=` (blank/placeholder) lines for a committed .env.example. */
  envExampleContent: z.string(),
  /** Lines to add to .gitignore (e.g. [".env"]). Empty if .env is already ignored. */
  gitignoreAdditions: z.array(z.string()),
  envAlreadyGitignored: z.boolean(),
  replacements: z.array(EnvReplacementSchema),
} as const;
export const EnvPlanSchema = z.object(envPlanShape);
export type EnvPlan = z.infer<typeof EnvPlanSchema>;

/** A heuristic access-control / security-posture finding. */
export const accessControlFindingShape = {
  /** e.g. "cors-wildcard" | "no-auth-middleware" | "missing-allowlist" |
   *  "debug-enabled" | "weak-secret-default" | "bind-all-interfaces". */
  kind: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  message: z.string(),
  recommendation: z.string(),
} as const;
export const AccessControlFindingSchema = z.object(accessControlFindingShape);
export type AccessControlFinding = z.infer<typeof AccessControlFindingSchema>;

/** The detected stack: app shape + datastores + languages + container files. */
export const preflightStackShape = {
  /** "next" | "vite-react" | "sveltekit" | "astro" | ... (undefined if none). */
  frontend: z.string().optional(),
  /** "express" | "fastapi" | "nestjs" | "django" | ... (undefined if none). */
  backend: z.string().optional(),
  /** e.g. ["postgres", "redis"]. */
  databases: z.array(z.string()),
  /** e.g. ["typescript", "python"]. */
  languages: z.array(z.string()),
  hasDockerfile: z.boolean(),
  dockerfiles: z.array(z.string()),
  composeFiles: z.array(z.string()),
} as const;
export const PreflightStackSchema = z.object(preflightStackShape);
export type PreflightStack = z.infer<typeof PreflightStackSchema>;

/** Detected build/test/run commands + ordered instructions (detect & instruct). */
export const buildPlanShape = {
  /** "npm" | "yarn" | "pnpm" | "bun" | "pip" | "poetry" | "go" (undefined if unknown). */
  packageManager: z.string().optional(),
  install: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  start: z.string().optional(),
  typecheck: z.string().optional(),
  /** Best-guess entry file, e.g. "src/index.ts" / "app/main.py". */
  entrypoint: z.string().optional(),
  /** Ordered "run these before deploying" steps for the host AI. */
  instructions: z.array(z.string()),
} as const;
export const BuildPlanSchema = z.object(buildPlanShape);
export type BuildPlan = z.infer<typeof BuildPlanSchema>;

/**
 * A positive read on whether the app implements user login/auth, and what kind.
 * Unlike the access-control `no-auth-middleware` finding (which only fires on the
 * ABSENCE of an auth keyword), this is an explicit assessment the host AI can act
 * on: when `loginImplemented` is false and the app exposes routes that imply it
 * SHOULD have sign-in, `recommendation` offers to scaffold Google auth (call the
 * `scaffold_auth` tool). It is a best-effort heuristic — `confidence` and
 * `signals` make the basis explicit rather than implying a real auth audit.
 */
export const authAssessmentShape = {
  /** Best-effort: does the app appear to implement user login/auth? */
  loginImplemented: z.boolean(),
  /** Detected auth mechanisms/libraries, e.g. ["next-auth", "passport", "express-session"]. */
  mechanisms: z.array(z.string()),
  /** Detected social/OAuth providers if any, e.g. ["google", "github"]. */
  providers: z.array(z.string()),
  /** Heuristic confidence in [0,1] for the loginImplemented verdict. */
  confidence: z.number().min(0).max(1),
  /** Supporting evidence, each "file:line — what was seen". Never a secret value. */
  signals: z.array(z.string()),
  /** Whether mutating/protected routes were seen (implies the app should gate access). */
  mutatingRoutesPresent: z.boolean(),
  /** Actionable next step. When login is missing, suggests offering Google auth. */
  recommendation: z.string(),
  /** True when the host AI should OFFER to add login (none found but app needs it). */
  offerGoogleAuth: z.boolean(),
} as const;
export const AuthAssessmentSchema = z.object(authAssessmentShape);
export type AuthAssessment = z.infer<typeof AuthAssessmentSchema>;

/* ------------------------------------------------------------------ */
/* preflight_scan I/O                                                  */
/* ------------------------------------------------------------------ */

export const preflightScanInputShape = {
  files: z.array(PreflightFileSchema),
  /**
   * product (public sign-in expected) vs internal (allowlist required). It tunes
   * the access-control checks: in "internal" a missing ALLOWED_EMAILS/
   * ALLOWED_DOMAIN allowlist is flagged; in "product" it is not. Defaults to
   * "product".
   */
  mode: z.enum(["product", "internal"]).optional(),
} as const;
export const PreflightScanInputSchema = z.object(preflightScanInputShape);
export type PreflightScanInput = z.infer<typeof PreflightScanInputSchema>;

export const preflightScanOutputShape = {
  signals: RepoSignalsSchema,
  stack: PreflightStackSchema,
  services: z.array(DetectedServiceSchema),
  secrets: z.array(SecretFindingSchema),
  envPlan: EnvPlanSchema,
  accessControl: z.array(AccessControlFindingSchema),
  /**
   * Positive login/auth assessment: whether the app implements sign-in, by what
   * mechanism, and — when it's missing but the app needs it — a recommendation to
   * offer Google auth (scaffold via the `scaffold_auth` tool).
   */
  auth: AuthAssessmentSchema,
  build: BuildPlanSchema,
  securityFollowups: z.array(z.string()),
  instructions: z.array(z.string()),
  /**
   * Relevant files the scan EXPECTED but did NOT receive in `files`, each with
   * the finding it leaves unverified (e.g. ".gitignore — .env-hygiene findings
   * unverified"). preflight_scan's quality depends on the host passing the right
   * files; this tells the host what to add and re-run. Empty when nothing's missing.
   */
  notProvided: z.array(z.string()),
  summary: z.string(),
} as const;
export const PreflightScanOutputSchema = z.object(preflightScanOutputShape);
export type PreflightScanOutput = z.infer<typeof PreflightScanOutputSchema>;

/* ------------------------------------------------------------------ */
/* review_code (vulnerability review)                                  */
/* ------------------------------------------------------------------ */

/**
 * review_code is a PURE, heuristic code-vulnerability review (no network/FS):
 * the host AI passes the files it read; the tool returns prioritised findings
 * across categories like XSS, SQL/command injection, error info-disclosure,
 * disabled TLS verification, missing auth on mutating routes, missing security
 * headers / rate-limiting, eval, weak crypto, and open redirects — each with a
 * concrete `recommendation`. It does NOT edit files (the server is pure); the
 * host AI applies the recommendations with its own file tools (confirm risky
 * changes with the user first).
 */
export const reviewFindingShape = {
  /** Stable detector id, e.g. "xss-innerhtml", "sql-injection", "tls-disabled". */
  id: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  /** "xss" | "injection" | "info-disclosure" | "tls" | "auth" | "headers" |
   *  "rate-limit" | "crypto" | "open-redirect" | "secrets" | ... */
  category: z.string(),
  file: z.string(),
  line: z.number().int().nonnegative(),
  title: z.string(),
  detail: z.string(),
  /** Concrete fix the host AI should apply. */
  recommendation: z.string(),
} as const;
export const ReviewFindingSchema = z.object(reviewFindingShape);
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const reviewCodeInputShape = {
  files: z.array(PreflightFileSchema),
} as const;
export const ReviewCodeInputSchema = z.object(reviewCodeInputShape);
export type ReviewCodeInput = z.infer<typeof ReviewCodeInputSchema>;

export const reviewCodeOutputShape = {
  findings: z.array(ReviewFindingSchema),
  counts: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
  }),
  summary: z.string(),
} as const;
export const ReviewCodeOutputSchema = z.object(reviewCodeOutputShape);
export type ReviewCodeOutput = z.infer<typeof ReviewCodeOutputSchema>;

/* ================================================================== */
/* M8 - scaffold_auth (offer + scaffold Google sign-in)                */
/* ================================================================== */

/*
 * scaffold_auth is a PURE tool (no filesystem/network): when preflight_scan's
 * `auth.loginImplemented` is false (and the app should have sign-in), the host AI
 * OFFERS to add login, and on the user's yes calls scaffold_auth to get a
 * ready-to-apply Google OAuth scaffold. The server is pure, so the tool RETURNS
 * the files/steps and the host AI writes them with its own file tools.
 *
 * It tailors the scaffold to the app's framework: "nextjs" (Auth.js / NextAuth
 * Google provider), "express" (passport-google-oauth20 + express-session), or a
 * framework-agnostic "generic" set of steps. M8 supports provider "google".
 */
export const ScaffoldAuthProviderSchema = z.enum(["google"]);
export type ScaffoldAuthProvider = z.infer<typeof ScaffoldAuthProviderSchema>;

export const ScaffoldAuthFrameworkSchema = z.enum([
  "nextjs",
  "express",
  "generic",
]);
export type ScaffoldAuthFramework = z.infer<typeof ScaffoldAuthFrameworkSchema>;

export const scaffoldAuthInputShape = {
  /** OAuth provider to scaffold. M8 supports "google" (the default). */
  provider: ScaffoldAuthProviderSchema.optional(),
  /**
   * Target framework. If omitted, it is inferred from `stack` (e.g. a "next"
   * frontend -> "nextjs", an "express" backend -> "express"), else "generic".
   */
  framework: ScaffoldAuthFrameworkSchema.optional(),
  /** Stack hint from preflight_scan (e.g. stack.frontend / stack.backend) to infer the framework. */
  stack: z.string().optional(),
  /** product (public sign-in) vs internal (gate to an allowlist). Defaults to "product". */
  mode: z.enum(["product", "internal"]).optional(),
  /** Base URL of the deployed app, used to build the OAuth redirect URI(s). */
  appUrl: z.string().optional(),
  /** Internal mode: restrict sign-in to this email domain (e.g. "yourco.com"). */
  allowedDomain: z.string().optional(),
} as const;
export const ScaffoldAuthInputSchema = z.object(scaffoldAuthInputShape);
export type ScaffoldAuthInput = z.infer<typeof ScaffoldAuthInputSchema>;

/** One file the host AI should create or merge to wire up auth. */
export const scaffoldFileShape = {
  path: z.string(),
  contents: z.string(),
  /** create = new file; merge = blend into an existing file; modify = manual edit per `note`. */
  action: z.enum(["create", "merge", "modify"]),
  note: z.string().optional(),
} as const;
export const ScaffoldFileSchema = z.object(scaffoldFileShape);
export type ScaffoldFile = z.infer<typeof ScaffoldFileSchema>;

/** An env var the scaffold needs (name + example placeholder; never a real value). */
export const scaffoldEnvVarShape = {
  key: z.string(),
  example: z.string(),
  secret: z.boolean(),
  note: z.string().optional(),
} as const;
export const ScaffoldEnvVarSchema = z.object(scaffoldEnvVarShape);
export type ScaffoldEnvVar = z.infer<typeof ScaffoldEnvVarSchema>;

export const scaffoldAuthOutputShape = {
  provider: z.string(),
  /** The framework the scaffold targets (resolved from input/stack). */
  framework: ScaffoldAuthFrameworkSchema,
  /** Packages to install (npm), e.g. ["next-auth"] or ["passport", "passport-google-oauth20", "express-session"]. */
  dependencies: z.array(z.string()),
  /** Env vars to set (names + placeholders). The host fills the real values. */
  envVars: z.array(ScaffoldEnvVarSchema),
  /** OAuth redirect URI(s) to register in the Google Cloud console. */
  redirectUris: z.array(z.string()),
  /** Files to create/merge (contents included) to wire up Google sign-in. */
  files: z.array(ScaffoldFileSchema),
  /** Ordered setup steps (create the Google OAuth client, install deps, write files, …). */
  steps: z.array(z.string()),
  /** Footguns/warnings (redirect-URI exactness, session secret, internal-mode gating, …). */
  warnings: z.array(z.string()),
  summary: z.string(),
} as const;
export const ScaffoldAuthOutputSchema = z.object(scaffoldAuthOutputShape);
export type ScaffoldAuthOutput = z.infer<typeof ScaffoldAuthOutputSchema>;
