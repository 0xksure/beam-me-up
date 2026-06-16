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

export const checkCredentialsOutputShape = {
  /** Vercel deploys (VERCEL_TOKEN). */
  vercel: z.boolean(),
  /** DigitalOcean deploys (DIGITALOCEAN_TOKEN). */
  digitalocean: z.boolean(),
  /** Postgres provisioning via Neon (NEON_API_KEY). */
  neon: z.boolean(),
  /** Redis provisioning via Upstash (UPSTASH_EMAIL + UPSTASH_API_KEY). */
  upstash: z.boolean(),
  /** Capability names that ARE configured (a convenience for the planner). */
  configured: z.array(z.string()),
  /** Capability names that are NOT configured, with the env var(s) to set. */
  missing: z.array(z.string()),
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
