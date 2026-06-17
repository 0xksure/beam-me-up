/**
 * preflightScan - the M3 preflight_scan tool handler (PURE: no filesystem, no
 * network). It composes the existing signal detector with the M3 detectors into
 * a single structural + security read of the repo.
 *
 * Mirrors the other pure M0 tools (route-target.ts / validate-compose.ts /
 * write-todo.ts): takes the already-validated args object, returns the output
 * object. It NEVER throws for a normal (even empty) input — an empty file list
 * just yields empty findings + a summary saying so.
 *
 * Composition (per PINNED CONTRACT):
 *   - signals      = deriveSignals(files)                  (../detect/signals.js)
 *   - stack        = detectStack(files)                    (../detect/stack.js)
 *   - services     = detectServices(files)                 (../detect/stack.js)
 *   - secrets      = detectSecrets(files)                  (../detect/secrets.js)
 *   - envPlan      = buildEnvPlan(files, secrets)          (../detect/secrets.js)
 *   - accessControl= detectAccessControl(files, mode)      (../detect/access-control.js)
 *   - build        = detectBuild(files)                    (../detect/stack.js)
 *   mode defaults to "product" when not supplied.
 *
 * Then it assembles the cross-cutting fields:
 *   - securityFollowups: short strings for write_todo's securityFollowups[],
 *     derived from the secrets + access-control findings + a ".env gitignored"
 *     reminder when envPlan.gitignoreAdditions is non-empty. Each high-severity
 *     finding should produce a clear one-liner (e.g. "Rotate and move the
 *     hardcoded STRIPE_SECRET_KEY in src/pay.ts:12 into an env var.").
 *   - instructions: ordered host-AI next steps, e.g.
 *       1. move the N detected secrets into .env (if any) + add .env to .gitignore,
 *       2. the build.instructions (verify it builds/tests),
 *       3. address the high-severity access-control findings,
 *       4. feed `signals`/`services` into route_target and `securityFollowups`
 *          into write_todo.
 *   - summary: one short paragraph — stack (frontend/backend/databases),
 *     #secrets, #access-control findings, whether a Dockerfile/compose exists,
 *     and the headline recommendation. NEVER include any secret value.
 *
 * STUB (M3 skeleton): the body is filled in by the implementer; the signature
 * is final.
 */
import type {
  AccessControlFinding,
  AuthAssessment,
  EnvPlan,
  PreflightFile,
  PreflightScanInput,
  PreflightScanOutput,
  PreflightStack,
  SecretFinding,
} from "@beam-me-up/core";
import { detectAccessControl } from "./access-control.js";
import { detectAuth } from "./auth-detect.js";
import { buildEnvPlan, detectSecrets } from "./secrets.js";
import { deriveSignals } from "./signals.js";
import { detectBuild, detectServices, detectStack } from "./stack.js";

export function preflightScan(
  input: PreflightScanInput,
): PreflightScanOutput {
  const files = input.files ?? [];
  const mode = input.mode ?? "product";

  // ---- Run the detectors (each is pure over { path, content }[]) ------
  const signals = deriveSignals(files);
  const stack = detectStack(files);
  const services = detectServices(files);
  const secrets = detectSecrets(files);
  const envPlan = buildEnvPlan(files, secrets);
  const accessControl = detectAccessControl(files, mode);
  const auth = detectAuth(files);
  const build = detectBuild(files);

  // ---- Cross-cutting fields -------------------------------------------
  const securityFollowups = buildSecurityFollowups(
    secrets,
    accessControl,
    envPlan,
    auth,
  );
  const instructions = buildInstructions(
    secrets,
    envPlan,
    accessControl,
    build,
  );
  const summary = buildSummary(stack, secrets, accessControl);
  const notProvided = computeNotProvided(files);

  return {
    signals,
    stack,
    services,
    secrets,
    envPlan,
    accessControl,
    auth,
    build,
    securityFollowups,
    instructions,
    notProvided,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* input-completeness                                                  */
/* ------------------------------------------------------------------ */

/**
 * Relevant files the scan relies on but did NOT receive, each with the finding
 * it leaves unverified. The scan's quality hinges on the host passing the right
 * files (the canonical trap: omitting .gitignore -> a false "add .env to
 * .gitignore"). This makes that gap explicit instead of silent.
 */
function computeNotProvided(files: PreflightFile[]): string[] {
  const have = new Set(
    files.map((f) => (f?.path ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? ""),
  );
  const out: string[] = [];

  if (!have.has(".gitignore")) {
    out.push(
      ".gitignore — .env / secret-in-git hygiene findings are UNVERIFIED (pass it and re-run)",
    );
  }
  const manifests = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "gemfile",
  ];
  if (!manifests.some((m) => have.has(m))) {
    out.push(
      "a manifest (package.json / pyproject.toml / go.mod / …) — stack, build, and database detection may be incomplete",
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* securityFollowups                                                   */
/* ------------------------------------------------------------------ */

/**
 * Short one-liners to feed straight into write_todo's securityFollowups[].
 * Derived from the high-severity secret findings + the access-control findings
 * + a ".env not gitignored" reminder when there is something to gitignore.
 *
 * SECURITY: these strings NEVER contain a raw secret value — we only ever use
 * the suggestedEnvKey / file:line / masked-free descriptions.
 */
function buildSecurityFollowups(
  secrets: SecretFinding[],
  accessControl: AccessControlFinding[],
  envPlan: EnvPlan,
  auth: AuthAssessment,
): string[] {
  const followups: string[] = [];

  // High-severity hardcoded secrets -> rotate + move into env.
  for (const secret of secrets) {
    if (secret.severity !== "high") continue;
    followups.push(
      `Rotate and move the hardcoded ${secret.suggestedEnvKey} (${secret.kind}) in ${secret.file}:${secret.line} into an env var.`,
    );
  }

  // No login but the app serves requests -> offer to add Google sign-in.
  if (auth.offerGoogleAuth) {
    followups.push(
      "No login/auth detected: offer the user Google sign-in and scaffold it with scaffold_auth { provider: \"google\" }.",
    );
  }

  // Access-control findings (high first, then the rest) -> address them.
  for (const finding of sortBySeverity(accessControl)) {
    const where = locationSuffix(finding.file, finding.line);
    followups.push(
      `[${finding.severity}] ${finding.message}${where} — ${finding.recommendation}`,
    );
  }

  // .env hygiene reminder when there is anything to add to .gitignore.
  if (envPlan.gitignoreAdditions.length > 0) {
    followups.push(
      `Add ${envPlan.gitignoreAdditions
        .map((entry) => `\`${entry}\``)
        .join(", ")} to .gitignore so the .env with real credentials is never committed.`,
    );
  }

  return followups;
}

/* ------------------------------------------------------------------ */
/* instructions                                                        */
/* ------------------------------------------------------------------ */

/**
 * Ordered "what the host AI should do next" steps:
 *   1. migrate the detected secrets into .env + gitignore .env,
 *   2. run the build/test/start steps (build.instructions),
 *   3. fix the high-severity access-control findings,
 *   4. feed signals/services into route_target and securityFollowups into
 *      write_todo.
 *
 * SECURITY: never embeds a raw secret value (only counts / env keys).
 */
function buildInstructions(
  secrets: SecretFinding[],
  envPlan: EnvPlan,
  accessControl: AccessControlFinding[],
  build: { instructions: string[] },
): string[] {
  const instructions: string[] = [];

  // 1. Secret migration.
  if (secrets.length > 0) {
    const keys = uniqueEnvKeys(secrets);
    instructions.push(
      `Move the ${secrets.length} detected hardcoded secret${secrets.length === 1 ? "" : "s"} (${keys.join(", ")}) out of source and into a local .env, replacing each literal with a process.env reference.`,
    );
    if (envPlan.gitignoreAdditions.length > 0) {
      instructions.push(
        `Add ${envPlan.gitignoreAdditions
          .map((entry) => `\`${entry}\``)
          .join(", ")} to .gitignore and commit a .env.example with blank values for those keys.`,
      );
    }
  }

  // 2. Build / test / run verification.
  for (const step of build.instructions) {
    instructions.push(step);
  }

  // 3. Address high-severity access-control findings.
  const highAccess = accessControl.filter((f) => f.severity === "high");
  for (const finding of highAccess) {
    const where = locationSuffix(finding.file, finding.line);
    instructions.push(
      `Fix the high-severity ${finding.kind} issue${where}: ${finding.recommendation}`,
    );
  }

  // 4. Hand off to the other tools.
  instructions.push(
    "Pass `signals` and `services` from this scan into route_target to pick a deploy target (Vercel vs container).",
  );
  instructions.push(
    "Pass `securityFollowups` from this scan into write_todo so the ship checklist includes the security fixes.",
  );

  return instructions;
}

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */

/**
 * A short human-readable overview: stack (frontend/backend/databases), the
 * count of secrets + access-control findings, whether a container artefact
 * exists, and the headline recommendation.
 *
 * SECURITY: never includes a raw secret value — only counts and stack names.
 */
function buildSummary(
  stack: PreflightStack,
  secrets: SecretFinding[],
  accessControl: AccessControlFinding[],
): string {
  const stackParts: string[] = [];
  if (stack.frontend) stackParts.push(`frontend ${stack.frontend}`);
  if (stack.backend) stackParts.push(`backend ${stack.backend}`);
  if (stack.databases.length > 0) {
    stackParts.push(`databases ${stack.databases.join("/")}`);
  }
  const stackDesc =
    stackParts.length > 0 ? stackParts.join(", ") : "an unrecognized stack";

  const containerDesc = stack.hasDockerfile
    ? "a Dockerfile is present"
    : stack.composeFiles.length > 0
      ? "a docker-compose file is present"
      : "no Dockerfile or compose file was found";

  const highSecrets = secrets.filter((s) => s.severity === "high").length;
  const highAccess = accessControl.filter((f) => f.severity === "high").length;

  const secretsDesc = `${secrets.length} hardcoded secret${secrets.length === 1 ? "" : "s"}${highSecrets > 0 ? ` (${highSecrets} high-severity)` : ""}`;
  const accessDesc = `${accessControl.length} access-control finding${accessControl.length === 1 ? "" : "s"}${highAccess > 0 ? ` (${highAccess} high-severity)` : ""}`;

  const headline =
    highSecrets > 0 || highAccess > 0
      ? "Resolve the high-severity findings (rotate secrets, tighten access control) before deploying."
      : secrets.length > 0 || accessControl.length > 0
        ? "Address the findings below, then proceed to route_target and deploy."
        : "No blocking secrets or access-control issues found; proceed to route_target and deploy.";

  return `Detected ${stackDesc}; ${containerDesc}. Found ${secretsDesc} and ${accessDesc}. ${headline}`;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/** A " in file:line" / " in file" suffix, or "" when no location is known. */
function locationSuffix(file?: string, line?: number): string {
  if (!file) return "";
  if (typeof line === "number" && line > 0) return ` in ${file}:${line}`;
  return ` in ${file}`;
}

/** Access-control findings ordered high -> medium -> low (stable within rank). */
function sortBySeverity(
  findings: AccessControlFinding[],
): AccessControlFinding[] {
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...findings].sort(
    (a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3),
  );
}

/** De-duplicated suggestedEnvKey list, in first-seen order. */
function uniqueEnvKeys(secrets: SecretFinding[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const secret of secrets) {
    if (seen.has(secret.suggestedEnvKey)) continue;
    seen.add(secret.suggestedEnvKey);
    keys.push(secret.suggestedEnvKey);
  }
  return keys;
}
